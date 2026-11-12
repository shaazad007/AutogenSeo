"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveBrandCollection } = require("../lib/brandCollection");

test("uses an explicitly configured brand collection deterministically", () => {
  const brand = resolveBrandCollection({ collections: { nodes: [
    { handle: "new-arrivals", title: "New Arrivals" },
    { handle: "imrozia", title: "Imrozia" },
  ] } }, { brand_collection_handles: ["imrozia"] });
  assert.equal(brand, "Imrozia");
});

test("rejects sale/category collections and unconfigured queue titles", () => {
  const product = { collections: { nodes: [
    { handle: "eid-sale", title: "Eid Sale" },
    { handle: "new-arrivals", title: "New Arrivals" },
  ] } };
  assert.equal(resolveBrandCollection(product, { brand_collection_handles: ["imrozia"] }), null);
  assert.equal(resolveBrandCollection(product, { brand_collection_handles: ["imrozia"] }, {
    handle: "eid-sale", title: "Eid Sale",
  }), null);
});

test("uses a configured queue collection title and otherwise returns no collection", () => {
  assert.equal(resolveBrandCollection({}, { brand_collection_handles: ["imrozia"] }, {
    handle: "imrozia", title: "Imrozia",
  }), "Imrozia");
  assert.equal(resolveBrandCollection({}, { brand_collection_handles: [] }, {
    handle: "imrozia", title: "Imrozia",
  }), null);
});
