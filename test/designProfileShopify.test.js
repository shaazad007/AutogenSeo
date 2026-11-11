"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ShopifyClient } = require("../lib/shopify");

const productId = "gid://shopify/Product/42";
const designProfile = {
  schema_version: 1,
  brand: { value: "Sara Clothes", source: "shopify_vendor", confidence: 1 },
  colours: { primary: { value: "green", source: "image", confidence: 0.9 } },
  fabric: { shirt: { value: "organza", source: "shopify_description", confidence: 0.9 } },
  neckline: { shape: { value: "v_neck", source: "image", confidence: 0.8 } },
  design_style: { value: "festive", source: "image", confidence: 0.8 },
  matching_keywords: ["green organza", "gold embroidery"],
  metadata: {
    schema_version: 1,
    evidence_source: "ai_vision+shopify_product_context",
    confidence: 0.88,
    image_fingerprint: "a".repeat(64),
  },
};

function definition(overrides = {}) {
  return {
    id: "gid://shopify/MetafieldDefinition/1",
    name: "AI Design Profile",
    namespace: "custom",
    key: "ai_design",
    ownerType: "PRODUCT",
    type: { name: "json" },
    ...overrides,
  };
}

function mockClient(handler) {
  const client = new ShopifyClient({
    store: "example.myshopify.com",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  });
  client.graphql = handler;
  return client;
}

test("creates compatible product JSON definition, writes profile, verifies readback and is idempotent", async () => {
  let definitionExists = false;
  let stored = null;
  const calls = [];
  const client = mockClient(async (query, variables = {}) => {
    calls.push({ query, variables });
    if (query.includes("CreateDesignProfileDefinition")) {
      definitionExists = true;
      return { metafieldDefinitionCreate: { createdDefinition: definition(), userErrors: [] } };
    }
    if (query.includes("DesignProfileDefinition")) {
      return { metafieldDefinitions: { nodes: definitionExists ? [definition()] : [] } };
    }
    if (query.includes("ExistingDesignProfile")) {
      return { product: { metafield: stored ? { type: "json", value: stored } : null } };
    }
    if (query.includes("SetDesignProfile")) {
      const input = variables.metafields[0];
      assert.equal(input.ownerId, productId);
      assert.equal(input.namespace, "custom");
      assert.equal(input.key, "ai_design");
      assert.equal(input.type, "json");
      assert.equal(input.compareDigest, null);
      stored = input.value;
      return { metafieldsSet: { metafields: [], userErrors: [] } };
    }
    throw new Error("Unexpected GraphQL query");
  });

  const first = await client.writeDesignProfile(productId, designProfile);
  assert.deepEqual(first, { unchanged: false, verified: true });
  const second = await client.writeDesignProfile(productId, designProfile);
  assert.deepEqual(second, { unchanged: true, verified: true });
  assert.equal(calls.filter((call) => call.query.includes("CreateDesignProfileDefinition")).length, 1);
  assert.equal(calls.filter((call) => call.query.includes("SetDesignProfile")).length, 1);
  assert.deepEqual(JSON.parse(stored).metadata.image_fingerprint, "a".repeat(64));
});

test("profile backfill fetch selects only ai-done products missing custom.ai_design", async () => {
  const client = mockClient(async (query, variables = {}) => {
    assert.match(query, /metafield\(namespace: "custom", key: "ai_design"\)/);
    assert.equal(variables.query, "tag:ai-done");
    return { products: {
      nodes: [
        { id: "missing", tags: ["ai-done"], designProfile: null },
        { id: "present", tags: ["ai-done"], designProfile: { value: "{}" } },
        { id: "pending", tags: [], designProfile: null },
      ],
      pageInfo: { hasNextPage: true, endCursor: "next-page" },
    } };
  });

  const page = await client.fetchProfileBackfillProducts({ first: 3 });
  assert.deepEqual(page, {
    products: [{ id: "missing", tags: ["ai-done"], designProfile: null }],
    hasNextPage: true,
    endCursor: "next-page",
  });
});

test("profile backfill honors the selected collection", async () => {
  const client = mockClient(async (query, variables = {}) => {
    if (query.includes("CollectionByHandle")) {
      assert.equal(variables.handle, "spring-edit");
      return { collectionByHandle: { id: "gid://shopify/Collection/7", title: "Spring Edit" } };
    }
    assert.match(query, /CollectionProfileBackfill/);
    assert.equal(variables.id, "gid://shopify/Collection/7");
    return { collection: { products: {
      nodes: [{ id: "in-collection", tags: ["ai-done"], designProfile: null }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } };
  });

  const page = await client.fetchProfileBackfillProducts({
    first: 5,
    collectionHandles: ["spring-edit"],
  });
  assert.deepEqual(page.products.map((product) => product.id), ["in-collection"]);
});

test("refuses incompatible existing definitions without overwriting them", async () => {
  let mutationCalled = false;
  const client = mockClient(async (query) => {
    if (query.includes("DesignProfileDefinition")) {
      return { metafieldDefinitions: { nodes: [definition({ type: { name: "single_line_text_field" } })] } };
    }
    mutationCalled = true;
    throw new Error("unexpected mutation");
  });

  await assert.rejects(
    client.ensureDesignProfileDefinition(),
    /ownerType=PRODUCT, type=single_line_text_field/,
  );
  assert.equal(mutationCalled, false);
});

test("surfaces metafieldsSet userErrors", async () => {
  const client = mockClient(async (query) => {
    if (query.includes("DesignProfileDefinition")) {
      return { metafieldDefinitions: { nodes: [definition()] } };
    }
    if (query.includes("ExistingDesignProfile")) return { product: { metafield: null } };
    if (query.includes("SetDesignProfile")) {
      return { metafieldsSet: { userErrors: [{ field: ["metafields", "0"], message: "Access denied" }] } };
    }
    throw new Error("readback should not occur after userErrors");
  });

  await assert.rejects(client.writeDesignProfile(productId, designProfile), /Access denied/);
});

test("uses Shopify compareDigest when replacing an existing profile", async () => {
  let currentValue = JSON.stringify({ schema_version: 0 });
  let setInput;
  const client = mockClient(async (query, variables = {}) => {
    if (query.includes("DesignProfileDefinition")) {
      return { metafieldDefinitions: { nodes: [definition()] } };
    }
    if (query.includes("ExistingDesignProfile")) {
      return { product: { metafield: {
        type: "json",
        value: currentValue,
        compareDigest: "existing-profile-digest",
      } } };
    }
    if (query.includes("SetDesignProfile")) {
      setInput = variables.metafields[0];
      currentValue = setInput.value;
      return { metafieldsSet: { userErrors: [] } };
    }
    throw new Error("Unexpected GraphQL query");
  });

  await client.writeDesignProfile(productId, designProfile);
  assert.equal(setInput.compareDigest, "existing-profile-digest");
});

test("rejects a metafield write that does not match verified readback", async () => {
  let setCalled = false;
  const client = mockClient(async (query) => {
    if (query.includes("DesignProfileDefinition")) {
      return { metafieldDefinitions: { nodes: [definition()] } };
    }
    if (query.includes("ExistingDesignProfile")) {
      return { product: { metafield: setCalled
        ? { type: "json", value: JSON.stringify({ schema_version: 1, brand: "wrong" }) }
        : null } };
    }
    if (query.includes("SetDesignProfile")) {
      setCalled = true;
      return { metafieldsSet: { userErrors: [] } };
    }
    throw new Error("Unexpected GraphQL query");
  });

  await assert.rejects(client.writeDesignProfile(productId, designProfile), /readback did not match/);
});
