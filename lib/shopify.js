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
const { normalizeDesignProfile, stableJson } = require("./designProfile");

const API_VERSION = "2025-07"; // bump this every few months as Shopify releases new stable versions

function compareProductPriority(a, b) {
  const dateValue = (value) => {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  const aPublished = dateValue(a.publishedAt);
  const bPublished = dateValue(b.publishedAt);
  const aCreated = dateValue(a.createdAt);
  const bCreated = dateValue(b.createdAt);
  const aPriority = aPublished ?? aCreated ?? 0;
  const bPriority = bPublished ?? bCreated ?? 0;
  if (aPriority !== bPriority) return bPriority - aPriority;
  const aId = String(a.id);
  const bId = String(b.id);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

function addProcessingCollection(products, collectionTitle) {
  if (!collectionTitle) return products;
  return products.map((product) => ({
    ...product,
    processingCollectionTitle: collectionTitle,
  }));
}

class ShopifyClient {
  constructor({ store, clientId, clientSecret }) {
    this.store = store.replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this._token = null;
    this._tokenExpiresAt = 0;
    this._designProfileDefinitionPromise = null;
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
   * Optionally restricted to a single collection handle.
   */
  async getCollectionGidByHandle(handle) {
    if (!this._collectionGidCache) this._collectionGidCache = {};
    if (!this._collectionTitleCache) this._collectionTitleCache = {};
    if (this._collectionGidCache[handle] !== undefined) {
      return this._collectionGidCache[handle];
    }

    const query = `
      query CollectionByHandle($handle: String!) {
        collectionByHandle(handle: $handle) { id title }
      }
    `;
    const data = await this.graphql(query, { handle });
    const gid = data.collectionByHandle && data.collectionByHandle.id; // e.g. "gid://shopify/Collection/123456789"

    if (!gid) {
      log(`WARNING: No collection found for handle "${handle}" — check the handle in config.json's collection_filter.`);
    } else {
      log(`Resolved collection "${handle}" -> "${data.collectionByHandle.title}"`);
      this._collectionTitleCache[handle] = data.collectionByHandle.title;
    }

    this._collectionGidCache[handle] = gid || null;
    return gid || null;
  }

  /** List every Shopify collection using cursor pagination. */
  async listCollections() {
    const query = `
      query Collections($first: Int!, $after: String) {
        collections(first: $first, after: $after, sortKey: TITLE) {
          pageInfo { hasNextPage endCursor }
          nodes { id handle title }
        }
      }
    `;
    const all = [];
    let after = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const data = await this.graphql(query, { first: 250, after });
      const connection = data.collections;
      all.push(...connection.nodes);
      hasNextPage = connection.pageInfo.hasNextPage;
      after = connection.pageInfo.endCursor;
    }
    return all;
  }

  /** Full inventory for the dashboard; run explicitly so it does not delay SEO batches. */
  async getAllCollectionStats({ skipHandles = new Set(), onStart, onCollection } = {}) {
    const collections = await this.listCollections();
    if (onStart) await onStart(collections);
    const results = [];
    for (let index = 0; index < collections.length; index += 1) {
      const collection = collections[index];
      if (skipHandles.has(collection.handle)) continue;
      const stats = await this.getCollectionStats(collection.handle);
      if (stats) {
        results.push(stats);
        if (onCollection) await onCollection(stats, index + 1, collections.length);
      }
    }
    return results;
  }

  /**
   * Lightweight total + done counts for one collection, for the dashboard's
   * per-collection progress list. Fetches only {id, tags} per product (no
   * images/description) so it's cheap even for large collections.
   */
  async getCollectionStats(handle) {
    const gid = await this.getCollectionGidByHandle(handle);
    if (!gid) return null;

    const query = `
      query CollectionStats($id: ID!, $first: Int!, $after: String) {
        collection(id: $id) {
          products(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id tags }
          }
        }
      }
    `;

    let total = 0;
    let done = 0;
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const data = await this.graphql(query, { id: gid, first: 250, after: cursor });
      const conn = data.collection && data.collection.products;
      if (!conn) break;
      for (const node of conn.nodes) {
        total += 1;
        if ((node.tags || []).some((t) => t.toLowerCase() === "ai-done")) done += 1;
      }
      hasNextPage = conn.pageInfo.hasNextPage;
      cursor = conn.pageInfo.endCursor;
    }

    return { handle, name: this._collectionTitleCache[handle] || handle, total, done };
  }

  /**
   * Fetch one page of a specific collection's products directly via the
   * collection's own product connection, then filter out already-tagged
   * ("ai-done") products in JS. We deliberately do NOT use the top-level
   * `products(query: "-tag:ai-done AND collection_id:X")` search here —
   * Shopify's Admin API has a known issue where combining collection_id
   * with other query terms can silently return zero results even when
   * matching products exist. Fetching via collection.products sidesteps
   * that entirely.
   */
  async fetchCollectionProductsPage(collectionGid, { first, cursor, collectionTitle = null }) {
    const query = `
      query CollectionProducts($id: ID!, $first: Int!, $after: String) {
        collection(id: $id) {
          products(first: $first, after: $after, sortKey: CREATED, reverse: true) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              publishedAt
              createdAt
              title
              handle
              vendor
              tags
              options { name values }
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
      }
    `;
    const data = await this.graphql(query, { id: collectionGid, first, after: cursor });
    const conn = data.collection && data.collection.products;
    if (!conn) return { products: [], hasNextPage: false, endCursor: null };

    const unprocessed = addProcessingCollection(conn.nodes.filter(
      (p) => !(p.tags || []).some((t) => t.toLowerCase() === "ai-done")
    ), collectionTitle);
    unprocessed.sort(compareProductPriority);

    return {
      products: unprocessed,
      hasNextPage: conn.pageInfo.hasNextPage,
      endCursor: conn.pageInfo.endCursor,
    };
  }

  async fetchUnprocessedProducts({ first = 25, cursor = null, collectionHandles = [] } = {}) {
    // Collection-scoped path (used when processor.js is draining one collection at a time).
    if (collectionHandles && collectionHandles.length) {
      const handle = collectionHandles[0]; // processor.js always passes exactly one handle here
      const gid = await this.getCollectionGidByHandle(handle);
      if (!gid) {
        return { products: [], hasNextPage: false, endCursor: null };
      }
      return this.fetchCollectionProductsPage(gid, {
        first,
        cursor,
        collectionTitle: this._collectionTitleCache && this._collectionTitleCache[handle],
      });
    }

    // Whole-catalog path — plain single-term search, no combo-filter issue here.
    const query = `
      query FetchProducts($first: Int!, $after: String, $query: String) {
        products(first: $first, after: $after, query: $query, sortKey: PUBLISHED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            publishedAt
            createdAt
            title
            handle
            vendor
            tags
            options { name values }
            collections(first: 10) { nodes { title handle } }
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

    const data = await this.graphql(query, { first, after: cursor, query: "-tag:ai-done" });
    const products = data.products.nodes.slice().sort(compareProductPriority);
    return {
      products,
      hasNextPage: data.products.pageInfo.hasNextPage,
      endCursor: data.products.pageInfo.endCursor,
    };
  }

  /** Fetch only already ai-done products that do not yet have a Design Profile. */
  async fetchProfileBackfillProducts({ first = 25, cursor = null, collectionHandles = [] } = {}) {
    if (collectionHandles && collectionHandles.length) {
      const handle = collectionHandles[0];
      const gid = await this.getCollectionGidByHandle(handle);
      if (!gid) return { products: [], hasNextPage: false, endCursor: null };

      const query = `
        query CollectionProfileBackfill($id: ID!, $first: Int!, $after: String) {
          collection(id: $id) {
            products(first: $first, after: $after, sortKey: PUBLISHED_AT, reverse: true) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id publishedAt createdAt title handle vendor tags options { name values }
                descriptionHtml seo { title description }
                designProfile: metafield(namespace: "custom", key: "custom_ai_design") { value }
                media(first: 10) { nodes { ... on MediaImage { id image { url altText } } } }
              }
            }
          }
        }
      `;
      const data = await this.graphql(query, { id: gid, first, after: cursor });
      const conn = data.collection && data.collection.products;
      if (!conn) return { products: [], hasNextPage: false, endCursor: null };
      const products = addProcessingCollection(conn.nodes.filter((product) =>
        (product.tags || []).some((tag) => tag.toLowerCase() === "ai-done") &&
        !(product.designProfile && product.designProfile.value)
      ), this._collectionTitleCache && this._collectionTitleCache[handle]).sort(compareProductPriority);
      return { products, hasNextPage: conn.pageInfo.hasNextPage, endCursor: conn.pageInfo.endCursor };
    }

    const query = `
      query ProfileBackfillProducts($first: Int!, $after: String, $query: String) {
        products(first: $first, after: $after, query: $query, sortKey: PUBLISHED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id publishedAt createdAt title handle vendor tags options { name values }
            collections(first: 10) { nodes { title handle } }
            descriptionHtml seo { title description }
            designProfile: metafield(namespace: "custom", key: "custom_ai_design") { value }
            media(first: 10) { nodes { ... on MediaImage { id image { url altText } } } }
          }
        }
      }
    `;
    const data = await this.graphql(query, { first, after: cursor, query: "tag:ai-done" });
    const products = data.products.nodes.filter((product) =>
      (product.tags || []).some((tag) => tag.toLowerCase() === "ai-done") &&
      !(product.designProfile && product.designProfile.value)
    ).sort(compareProductPriority);
    return { products, hasNextPage: data.products.pageInfo.hasNextPage, endCursor: data.products.pageInfo.endCursor };
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

  async _readDesignProfileDefinition() {
    const query = `
      query DesignProfileDefinition {
        metafieldDefinitions(first: 2, namespace: "custom", key: "custom_ai_design", ownerType: PRODUCT) {
          nodes { id name namespace key ownerType type { name } }
        }
      }
    `;
    const data = await this.graphql(query);
    return (data.metafieldDefinitions.nodes || [])[0] || null;
  }

  _assertDesignProfileDefinition(definition) {
    if (!definition || definition.ownerType !== "PRODUCT" ||
        definition.namespace !== "custom" || definition.key !== "custom_ai_design" ||
        String(definition.type && definition.type.name).toLowerCase() !== "json") {
      const actualType = definition && definition.type && definition.type.name
        ? definition.type.name
        : "unknown";
      const actualOwner = definition && definition.ownerType ? definition.ownerType : "unknown";
      throw new Error(
        `Existing custom.custom_ai_design definition is incompatible (ownerType=${actualOwner}, type=${actualType}); it was not changed.`,
      );
    }
    return definition;
  }

  async _ensureDesignProfileDefinition() {
    let definition = await this._readDesignProfileDefinition();
    if (definition) return this._assertDesignProfileDefinition(definition);

    const mutation = `
      mutation CreateDesignProfileDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id name namespace key ownerType type { name } }
          userErrors { field message code }
        }
      }
    `;
    const data = await this.graphql(mutation, {
      definition: {
        name: "AI Design Profile",
        namespace: "custom",
        key: "custom_ai_design",
        description: "Versioned, image-grounded product design attributes.",
        ownerType: "PRODUCT",
        type: "json",
      },
    });
    const result = data.metafieldDefinitionCreate;
    if (result.userErrors && result.userErrors.length) {
      // Another worker may have created it between the read and mutation.
      definition = await this._readDesignProfileDefinition();
      if (definition) return this._assertDesignProfileDefinition(definition);
      throw new Error(
        `Could not create custom.custom_ai_design definition: ${JSON.stringify(result.userErrors)}`,
      );
    }
    return this._assertDesignProfileDefinition(result.createdDefinition);
  }

  async ensureDesignProfileDefinition() {
    if (!this._designProfileDefinitionPromise) {
      this._designProfileDefinitionPromise = this._ensureDesignProfileDefinition()
        .catch((error) => {
          this._designProfileDefinitionPromise = null;
          throw error;
        });
    }
    return this._designProfileDefinitionPromise;
  }

  async writeDesignProfile(productId, profile) {
    const normalized = normalizeDesignProfile(profile, {
      imageFingerprint: profile && profile.metadata && profile.metadata.image_fingerprint,
      contextFingerprint: profile && profile.metadata && profile.metadata.source_fingerprint,
    });
    await this.ensureDesignProfileDefinition();

    const readQuery = `
      query ExistingDesignProfile($id: ID!) {
        product(id: $id) {
          metafield(namespace: "custom", key: "custom_ai_design") { type value compareDigest }
        }
      }
    `;
    const existingData = await this.graphql(readQuery, { id: productId });
    const existing = existingData.product && existingData.product.metafield;
    if (existing && existing.type === "json") {
      try {
        if (stableJson(JSON.parse(existing.value)) === stableJson(normalized)) {
          return { unchanged: true, verified: true };
        }
      } catch (_) {
        // Replace malformed existing JSON with the validated current profile.
      }
    }

    const mutation = `
      mutation SetDesignProfile($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { namespace key type value }
          userErrors { field message code }
        }
      }
    `;
    const setData = await this.graphql(mutation, {
      metafields: [{
        ownerId: productId,
        namespace: "custom",
        key: "custom_ai_design",
        type: "json",
        value: JSON.stringify(normalized),
        compareDigest: existing ? existing.compareDigest : null,
      }],
    });
    const errors = setData.metafieldsSet.userErrors || [];
    if (errors.length) {
      throw new Error(`Design Profile metafield write failed: ${JSON.stringify(errors)}`);
    }

    const verifiedData = await this.graphql(readQuery, { id: productId });
    const verified = verifiedData.product && verifiedData.product.metafield;
    let verifiedProfile;
    try {
      verifiedProfile = verified && verified.type === "json"
        ? JSON.parse(verified.value)
        : null;
    } catch (_) {
      verifiedProfile = null;
    }
    if (!verifiedProfile || stableJson(verifiedProfile) !== stableJson(normalized)) {
      throw new Error("Design Profile metafield readback did not match the saved profile.");
    }
    return { unchanged: false, verified: true };
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
