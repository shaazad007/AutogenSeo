"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ShopifyClient } = require("../lib/shopify");

function product(id, publishedAt, createdAt, tags = []) {
  return {
    id,
    publishedAt,
    createdAt,
    tags,
    media: { nodes: [] },
  };
}

test("catalog fetch prioritizes publication date, then creation date and ID", async () => {
  const client = new ShopifyClient({ store: "example.myshopify.com", clientId: "id", clientSecret: "secret" });
  let request;
  client.graphql = async (query, variables) => {
    request = { query, variables };
    return {
      products: {
        nodes: [
          product("gid://shopify/Product/older", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"),
          product("gid://shopify/Product/fallback-new", null, "2026-01-01T00:00:00Z"),
          product("gid://shopify/Product/newest", "2026-02-01T00:00:00Z", "2025-01-01T00:00:00Z"),
          product("gid://shopify/Product/tie-b", "2026-02-01T00:00:00Z", "2025-01-01T00:00:00Z"),
        ],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      },
    };
  };

  const page = await client.fetchUnprocessedProducts({ first: 2, cursor: "cursor-0" });

  assert.deepEqual(page.products.map((item) => item.id), [
    "gid://shopify/Product/newest",
    "gid://shopify/Product/tie-b",
    "gid://shopify/Product/fallback-new",
    "gid://shopify/Product/older",
  ]);
  assert.match(request.query, /sortKey:\s*PUBLISHED_AT,\s*reverse:\s*true/);
  assert.match(request.query, /publishedAt\s+createdAt/);
  assert.equal(request.variables.query, "-tag:ai-done");
  assert.deepEqual(request.variables, { first: 2, after: "cursor-0", query: "-tag:ai-done" });
  assert.equal(page.hasNextPage, true);
  assert.equal(page.endCursor, "cursor-1");
});

test("collection fetch keeps collection scope and AI-done filtering with deterministic date fallback", async () => {
  const client = new ShopifyClient({ store: "example.myshopify.com", clientId: "id", clientSecret: "secret" });
  client.getCollectionGidByHandle = async (handle) => {
    assert.equal(handle, "summer-edit");
    return "gid://shopify/Collection/42";
  };
  let request;
  client.graphql = async (query, variables) => {
    request = { query, variables };
    return {
      collection: {
        products: {
          nodes: [
            product("gid://shopify/Product/old", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"),
            product("gid://shopify/Product/new", null, "2026-03-01T00:00:00Z"),
            product("gid://shopify/Product/done", "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z", ["AI-DONE"]),
          ],
          pageInfo: { hasNextPage: true, endCursor: "collection-cursor" },
        },
      },
    };
  };

  const page = await client.fetchUnprocessedProducts({
    first: 10,
    cursor: "collection-start",
    collectionHandles: ["summer-edit"],
  });

  assert.deepEqual(page.products.map((item) => item.id), [
    "gid://shopify/Product/new",
    "gid://shopify/Product/old",
  ]);
  assert.match(request.query, /sortKey:\s*CREATED,\s*reverse:\s*true/);
  assert.match(request.query, /publishedAt\s+createdAt/);
  assert.deepEqual(request.variables, {
    id: "gid://shopify/Collection/42",
    first: 10,
    after: "collection-start",
  });
  assert.equal(page.hasNextPage, true);
  assert.equal(page.endCursor, "collection-cursor");
});

test("unknown or invalid product dates sort deterministically by ID", async () => {
  const client = new ShopifyClient({ store: "example.myshopify.com", clientId: "id", clientSecret: "secret" });
  client.graphql = async () => ({
    products: {
      nodes: [
        product("gid://shopify/Product/b", "invalid", null),
        product("gid://shopify/Product/a", null, null),
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });

  const page = await client.fetchUnprocessedProducts();
  assert.deepEqual(page.products.map((item) => item.id), [
    "gid://shopify/Product/a",
    "gid://shopify/Product/b",
  ]);
});

test("exact queue fetch preserves submitted ID order and skips missing or ai-done products", async () => {
  const client = new ShopifyClient({ store: "example.myshopify.com", clientId: "id", clientSecret: "secret" });
  let request;
  client.graphql = async (query, variables) => {
    request = { query, variables };
    return { nodes: [
      product("gid://shopify/Product/3", null, null),
      product("gid://shopify/Product/1", null, null),
      product("gid://shopify/Product/2", null, null, ["AI-DONE"]),
      null,
    ] };
  };
  const result = await client.fetchUnprocessedProductsByIds([
    "gid://shopify/Product/1",
    "gid://shopify/Product/2",
    "gid://shopify/Product/missing",
    "gid://shopify/Product/3",
  ]);
  assert.deepEqual(request.variables.ids, [
    "gid://shopify/Product/1",
    "gid://shopify/Product/2",
    "gid://shopify/Product/missing",
    "gid://shopify/Product/3",
  ]);
  assert.match(request.query, /nodes\(ids: \$ids\)/);
  assert.deepEqual(result.products.map((item) => item.id), [
    "gid://shopify/Product/1",
    "gid://shopify/Product/3",
  ]);
  assert.deepEqual(result.skippedProductIds, [
    "gid://shopify/Product/2",
    "gid://shopify/Product/missing",
  ]);
});
