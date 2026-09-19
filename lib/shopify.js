"use strict";

/**
 * Shopify Admin API bridge.
 *
 * Auth: uses the "client credentials" grant for Custom Apps created in the
 * Shopify Dev Dashboard. This is server-to-server — there is NO browser
 * OAuth popup / consent screen involved. We exchange SHOPIFY_CLIENT_ID +
 * SHOPIFY_CLIENT_SECRET for a short-lived Admin API access token, cache it
 * in memory for this run, and use it as the X-Shopify-Access-Token header
 * on every GraphQL call.
 *
 * Data access: GraphQL Admin API only (the REST Admin API for products is
 * legacy / being phased out).
 */

const { retryWithBackoff, log } = require("./util");

const API_VERSION = "2025-07"; // bump this every few months as Shopify releases new stable versions

class ShopifyClient {
  constructor({ store, clientId, clientSecret }) {
    this.store = store.replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  async _getAccessToken() {
    const now = Date.now();
    if (this._token && now < this._tokenExpiresAt - 60_000) {
      return this._token;
    }

    const url = `https://${this.store}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`Shopify token request failed (${res.status}): ${text}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    this._token = data.access_token;
    // Shopify client-credentials tokens are typically valid for 24h; refresh a bit early.
    this._tokenExpiresAt = now + (data.expires_in ? data.expires_in * 1000 : 23 * 60 * 60 * 1000);
    return this._token;
  }

  async graphql(query, variables = {}) {
    const token = await this._getAccessToken();
    const url = `https://${this.store}/admin/api/${API_VERSION}/graphql.json`;

    return retryWithBackoff(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token,
          },
          body: JSON.stringify({ query, variables }),
        });

        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          const err = new Error(`Shopify GraphQL HTTP ${res.status}: ${JSON.stringify(json)}`);
          err.status = res.status;
          throw err;
        }

        if (json.errors) {
          const err = new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
          // THROTTLED errors should be retried like a 429
          const throttled = JSON.stringify(json.errors).includes("THROTTLED");
          err.status = throttled ? 429 : 500;
          throw err;
        }

        // Cost-based rate limiting: back off proactively if we're close to the bucket limit.
        const cost = json.extensions && json.extensions.cost;
        if (cost && cost.throttleStatus) {
          const { currentlyAvailable, maximumAvailable } = cost.throttleStatus;
          if (currentlyAvailable < maximumAvailable * 0.2) {
            log("Close to Shopify GraphQL rate limit bucket — pausing briefly.");
            await new Promise((r) => setTimeout(r, 2000));
          }
        }

        return json.data;
      },
      { label: "Shopify GraphQL request" }
    );
  }

  /**
   * Fetch a page of products that do NOT yet have the "ai-done" tag.
   * Optionally restricted to a list of collection handles.
   */
  async getCollectionIdByHandle(handle) {
    if (!this._collectionIdCache) this._collectionIdCache = {};
    if (this._collectionIdCache[handle] !== undefined) {
      return this._collectionIdCache[handle];
    }

    const query = `
      query CollectionByHandle($handle: String!) {
        collectionByHandle(handle: $handle) { id }
      }
    `;
    const data = await this.graphql(query, { handle });
    const gid = data.collectionByHandle && data.collectionByHandle.id; // e.g. "gid://shopify/Collection/123456789"
    const numericId = gid ? gid.split("/").pop() : null;

    if (!numericId) {
      log(`WARNING: No collection found for handle "${handle}" — check the handle in config.json's collection_filter.`);
    }

    this._collectionIdCache[handle] = numericId;
    return numericId;
  }

  async fetchUnprocessedProducts({ first = 25, cursor = null, collectionHandles = [] } = {}) {
    let queryString = "-tag:ai-done";

    if (collectionHandles && collectionHandles.length) {
      const ids = [];
      for (const handle of collectionHandles) {
        const id = await this.getCollectionIdByHandle(handle);
        if (id) ids.push(id);
      }
      if (ids.length === 0) {
        // No valid collection matched — return no products rather than silently
        // falling back to the whole catalog.
        return { products: [], hasNextPage: false, endCursor: null };
      }
      const collectionsPart = ids.map((id) => `collection_id:${id}`).join(" OR ");
      queryString += ` AND (${collectionsPart})`;
    }

    const query = `
      query FetchProducts($first: Int!, $after: String, $query: String) {
        products(first: $first, after: $after, query: $query, sortKey: ID) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            vendor
            tags
            descriptionHtml
            seo { title description }
            media(first: 10) {
              nodes {
                ... on MediaImage {
                  id
                  image { url altText }
                }
              }
            }
          }
        }
      }
    `;

    const data = await this.graphql(query, { first, after: cursor, query: queryString });
    return {
      products: data.products.nodes,
      hasNextPage: data.products.pageInfo.hasNextPage,
      endCursor: data.products.pageInfo.endCursor,
    };
  }

  /** Total count of products still missing the "ai-done" tag (for progress estimates). */
  async countUnprocessedProducts() {
    const query = `
      query CountUnprocessed($query: String) {
        productsCount(query: $query) { count }
      }
    `;
    const data = await this.graphql(query, { query: "-tag:ai-done" });
    return data.productsCount.count;
  }

  async countTotalProducts() {
    const query = `query { productsCount { count } }`;
    const data = await this.graphql(query);
    return data.productsCount.count;
  }

  /**
   * Backup the original description into a metafield so it can always be restored.
   * Namespace/key: custom.ai_backup_description
   */
  async backupOriginalDescription(productId, originalHtml) {
    const mutation = `
      mutation BackupDescription($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `;
    const variables = {
      metafields: [
        {
          ownerId: productId,
          namespace: "ai_backup",
          key: "original_description_html",
          type: "multi_line_text_field",
          value: originalHtml || "",
        },
      ],
    };
    const data = await this.graphql(mutation, variables);
    const errors = data.metafieldsSet.userErrors;
    if (errors && errors.length) {
      throw new Error(`Backup metafield failed: ${JSON.stringify(errors)}`);
    }
  }

  /**
   * Update title, description, SEO fields and tags for a product.
   * Does NOT touch the handle/URL (kept stable on purpose for SEO).
   */
  async updateProduct(productId, { title, descriptionHtml, seoTitle, seoDescription, tags }) {
    const mutation = `
      mutation UpdateProduct($input: ProductInput!) {
        productUpdate(input: $input) {
          userErrors { field message }
        }
      }
    `;
    const input = { id: productId };
    if (title) input.title = title;
    if (descriptionHtml) input.descriptionHtml = descriptionHtml;
    if (seoTitle || seoDescription) {
      input.seo = {};
      if (seoTitle) input.seo.title = seoTitle;
      if (seoDescription) input.seo.description = seoDescription;
    }
    if (tags) input.tags = tags;

    const data = await this.graphql(mutation, { input });
    const errors = data.productUpdate.userErrors;
    if (errors && errors.length) {
      throw new Error(`productUpdate failed: ${JSON.stringify(errors)}`);
    }
  }

  /** Add a single tag (e.g. "ai-done") without touching other tags. */
  async addTag(productId, tag) {
    const mutation = `
      mutation AddTag($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }
    `;
    const data = await this.graphql(mutation, { id: productId, tags: [tag] });
    const errors = data.tagsAdd.userErrors;
    if (errors && errors.length) {
      throw new Error(`tagsAdd failed: ${JSON.stringify(errors)}`);
    }
  }

  /** Set alt text on one product image / media item. */
  async updateMediaAltText(productId, mediaId, altText) {
    const mutation = `
      mutation UpdateAlt($productId: ID!, $media: [UpdateMediaInput!]!) {
        productUpdateMedia(productId: $productId, media: $media) {
          media { alt }
          mediaUserErrors { field message }
        }
      }
    `;
    const data = await this.graphql(mutation, {
      productId,
      media: [{ id: mediaId, alt: altText }],
    });
    const errors = data.productUpdateMedia.mediaUserErrors;
    if (errors && errors.length) {
      throw new Error(`Alt text update failed: ${JSON.stringify(errors)}`);
    }
  }
}

module.exports = { ShopifyClient };