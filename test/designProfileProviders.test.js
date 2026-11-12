"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateProductContent } = require("../lib/generate");
const { generateWithGroq } = require("../lib/groq");
const { generateWithCloudflare } = require("../lib/cloudflare");

const promptConfig = {
  detect: "visible colours, embroidery, sleeves",
  extra_rules: "Never invent fabric.",
  language: "English",
  brand_name: "Sara Clothes",
  brand_url: "https://example.test",
  banned_phrases: [],
  meta_description_min_chars: 150,
  meta_description_max_chars: 160,
};

const generated = {
  description_html: "<p>Green organza with gold embroidery.</p>",
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

const product = {
  id: "gid://shopify/Product/1",
  title: "Green Organza Suit",
  vendor: "Sara Clothes",
  descriptionHtml: "<p>Organza fabric</p>",
  tags: [],
  options: [{ name: "Color", values: ["Green", "Gold"] }],
};

async function withMockFetch(t, generator, responseBody) {
  const originalFetch = global.fetch;
  let generationRequests = 0;
  let requestText = "";
  global.fetch = async (url, options = {}) => {
    if (!options.method) {
      const image = Buffer.from("mock image bytes");
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
    const body = JSON.parse(options.body);
    requestText = JSON.stringify(body);
    return { ok: true, json: async () => responseBody(body) };
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await generator();
  assert.equal(generationRequests, 1, "profile must share the existing image+copy request");
  assert.match(requestText, /design_profile/);
  assert.match(requestText, /Green/);
  assert.ok(result.design_profile);
  assert.equal(result.design_profile.schema_version, 1);
}

test("Gemini generates SEO and profile in one multimodal request", async (t) => {
  await withMockFetch(t, () => generateProductContent({
    apiKey: "test-key",
    visionModel: "vision-model",
    textModel: "text-model",
    product,
    imageUrls: ["https://cdn.example.test/product.png"],
    promptConfig,
    designers: [],
    models: [],
    includeDesignProfile: true,
  }), () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(generated) }] } }] }));
});

test("Groq fallback generates SEO and profile in one multimodal request", async (t) => {
  await withMockFetch(t, () => generateWithGroq({
    apiKey: "test-key",
    model: "vision-model",
    product,
    imageUrls: ["https://cdn.example.test/product.png"],
    promptConfig,
    designers: [],
    models: [],
    includeDesignProfile: true,
  }), () => ({ choices: [{ message: { content: JSON.stringify(generated) } }] }));
});

test("Cloudflare fallback generates SEO and profile in one multimodal request", async (t) => {
  await withMockFetch(t, () => generateWithCloudflare({
    apiToken: "test-token",
    accountId: "test-account",
    model: "vision-model",
    product,
    imageUrls: ["https://cdn.example.test/product.png"],
    promptConfig,
    designers: [],
    models: [],
    includeDesignProfile: true,
  }), () => ({ choices: [{ message: { content: JSON.stringify(generated) } }] }));
});
