"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { runBatch } = require("../lib/processor");
const { todayDateString } = require("../lib/util");

const response = {
  description_html: "<p>A green organza suit with gold embroidery.</p>",
  key_visual_detail: "gold embroidery",
  tags: ["green organza", "gold embroidery"],
  image_alt_text: "Green organza suit with gold embroidery",
  design_profile: {
    brand: { value: "Sara Clothes", source: "shopify_vendor", confidence: 1 },
    colours: { primary: { value: "green", source: "image", confidence: 0.9 } },
    fabric: { shirt: { value: "organza", source: "shopify_description", confidence: 0.9 } },
    neckline: { shape: { value: "unknown", source: "unknown", confidence: 0 } },
    design_style: { value: "festive", source: "image", confidence: 0.8 },
    matching_keywords: ["green organza", "gold embroidery"],
  },
};

function makeConfig(root, enabled) {
  const paths = {
    progress: path.join(root, "progress.json"),
    failedCsv: path.join(root, "failed.csv"),
    preview: path.join(root, "preview"),
    history: path.join(root, "history.json"),
  };
  fs.writeFileSync(paths.progress, JSON.stringify({
    today_date: todayDateString(),
    today_done: 0,
    total_done: 0,
    total_products: 1,
    status: "idle",
  }));
  fs.writeFileSync(paths.failedCsv, "");
  return {
    promptConfig: {
      detect: "garment colours, embroidery, sleeves",
      extra_rules: "Use confirmed evidence only.",
      language: "English",
      brand_name: "Sara Clothes",
      brand_url: "https://example.test",
      banned_phrases: [],
      meta_description_min_chars: 150,
      meta_description_max_chars: 160,
      daily_cap: 100,
      delay_seconds: 0,
      gemini_model_vision: "vision-model",
      gemini_model_text: "text-model",
      collection_filter: [],
    },
    designers: [],
    models: [],
    env: {
      GEMINI_API_KEY: "test-key",
      GROQ_API_KEY: null,
      CLOUDFLARE_API_TOKEN: null,
      CLOUDFLARE_ACCOUNT_ID: null,
      AI_DESIGN_PROFILE_ENABLED: enabled,
    },
    paths,
  };
}

function installMockFetch(t) {
  const originalFetch = global.fetch;
  let generationRequests = 0;
  global.fetch = async (_url, options = {}) => {
    if (!options.method) {
      const image = Buffer.from("product image fixture");
      return {
        ok: true,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => image.buffer.slice(
          image.byteOffset,
          image.byteOffset + image.byteLength,
        ),
      };
    }
    generationRequests += 1;
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(response) }] } }] }),
    };
  };
  t.after(() => { global.fetch = originalFetch; });
  return () => generationRequests;
}

function fakeShopify({ failProfileWrites = 0, aiDone = false } = {}) {
  const counters = { backups: 0, updates: 0, altUpdates: 0, profileWrites: 0 };
  const products = [{
    id: "gid://shopify/Product/42",
    title: "Green Organza Suit",
    handle: "green-organza-suit",
    vendor: "Sara Clothes",
    tags: aiDone ? ["ai-done"] : [],
    descriptionHtml: "<p>Organza fabric</p>",
    media: { nodes: [{ id: "gid://shopify/MediaImage/1", image: { url: "https://cdn.example.test/product.png" } }] },
  }];
  return {
    counters,
    products,
    async countTotalProducts() { return 1; },
    async countUnprocessedProducts() { return 1; },
    async fetchUnprocessedProducts() {
      const rows = products.splice(0, products.length);
      return { products: rows, hasNextPage: false, endCursor: null };
    },
    async fetchProfileBackfillProducts() {
      const rows = products.splice(0, products.length);
      return { products: rows, hasNextPage: false, endCursor: null };
    },
    async fetchOriginalDescription() { return ""; },
    async backupOriginalDescription() { counters.backups += 1; },
    async updateProduct() { counters.updates += 1; },
    async updateMediaAltText() { counters.altUpdates += 1; },
    async writeDesignProfile() {
      counters.profileWrites += 1;
      if (counters.profileWrites <= failProfileWrites) throw new Error("temporary profile write failure");
      return { verified: true };
    },
  };
}

test("Preview includes the Design Profile and performs no Shopify writes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-profile-preview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = makeConfig(root, false);
  const shopify = fakeShopify();
  delete shopify.fetchOriginalDescription;
  const generationRequests = installMockFetch(t);

  const result = await runBatch({
    shopify,
    config,
    mode: "preview",
    limit: 1,
    runLog: [],
  });

  const preview = fs.readFileSync(
    path.join(config.paths.preview, "01-green-organza-suit.txt"),
    "utf8",
  );
  assert.equal(result.processed, 1);
  assert.match(preview, /AI DESIGN PROFILE:/);
  assert.match(preview, /"schema_version": 1/);
  assert.equal(generationRequests(), 1);
  assert.deepEqual(shopify.counters, { backups: 0, updates: 0, altUpdates: 0, profileWrites: 0 });
});

test("profile backfill writes only the profile for ai-done products", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-profile-backfill-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = makeConfig(root, true);
  const shopify = fakeShopify({ aiDone: true });
  const generationRequests = installMockFetch(t);

  const result = await runBatch({
    shopify,
    config,
    mode: "profile-backfill",
    limit: 1,
    runLog: [],
  });

  const progress = JSON.parse(fs.readFileSync(config.paths.progress, "utf8"));
  assert.equal(result.processed, 1);
  assert.equal(generationRequests(), 1);
  assert.equal(shopify.counters.profileWrites, 1);
  assert.equal(shopify.counters.backups, 0);
  assert.equal(shopify.counters.updates, 0);
  assert.equal(shopify.counters.altUpdates, 0);
  assert.equal(progress.today_done, 0);
});

test("profile backfill retries a saved profile without another AI request", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-profile-backfill-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = makeConfig(root, true);
  const progress = JSON.parse(fs.readFileSync(config.paths.progress, "utf8"));
  progress.design_profile_retries = [{
    product_id: "gid://shopify/Product/42",
    title: "Green Organza Suit",
    profile: response.design_profile,
    attempts: 1,
  }];
  fs.writeFileSync(config.paths.progress, JSON.stringify(progress));
  const shopify = fakeShopify({ aiDone: true });
  const generationRequests = installMockFetch(t);

  const result = await runBatch({
    shopify,
    config,
    mode: "profile-backfill",
    limit: 1,
    runLog: [],
  });

  const completed = JSON.parse(fs.readFileSync(config.paths.progress, "utf8"));
  assert.equal(result.processed, 1);
  assert.equal(generationRequests(), 0);
  assert.equal(shopify.counters.profileWrites, 1);
  assert.equal(shopify.counters.updates, 0);
  assert.deepEqual(completed.design_profile_retries, []);
});

test("profile backfill refuses to run unless explicitly enabled", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-profile-backfill-disabled-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = makeConfig(root, false);
  const shopify = fakeShopify({ aiDone: true });

  await assert.rejects(runBatch({
    shopify,
    config,
    mode: "profile-backfill",
    limit: 1,
    runLog: [],
  }), /requires AI_DESIGN_PROFILE_ENABLED=true/);
  assert.deepEqual(shopify.counters, { backups: 0, updates: 0, altUpdates: 0, profileWrites: 0 });
});

test("profile write failure persists retry and recovers next run without another vision call", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-profile-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = makeConfig(root, true);
  const shopify = fakeShopify({ failProfileWrites: 1 });
  const generationRequests = installMockFetch(t);

  const first = await runBatch({
    shopify,
    config,
    mode: "live",
    limit: 1,
    runLog: [],
  });
  const pending = JSON.parse(fs.readFileSync(config.paths.progress, "utf8"));
  assert.equal(first.processed, 1);
  assert.equal(shopify.counters.updates, 1);
  assert.equal(shopify.counters.profileWrites, 1);
  assert.equal(pending.design_profile_retries.length, 1);
  assert.equal(pending.design_profile_retries[0].attempts, 1);
  assert.equal(generationRequests(), 1);

  shopify.countUnprocessedProducts = async () => 0;
  const second = await runBatch({
    shopify,
    config,
    mode: "live",
    limit: 1,
    runLog: [],
  });
  const completed = JSON.parse(fs.readFileSync(config.paths.progress, "utf8"));
  assert.equal(second.processed, 0);
  assert.equal(shopify.counters.profileWrites, 2);
  assert.deepEqual(completed.design_profile_retries, []);
  assert.equal(generationRequests(), 1, "profile retry must not rerun vision or SEO generation");
});
