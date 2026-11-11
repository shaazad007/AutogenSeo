"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeDesignProfile,
  groundDesignProfileInput,
  resolveCollectionBrand,
  fingerprintImages,
  fingerprintProductContext,
  stableJson,
} = require("../lib/designProfile");
const { buildCombinedPromptText, postProcessResult } = require("../lib/promptShared");

const promptConfig = {
  detect: "garment colour, neckline, sleeves, embroidery",
  extra_rules: "Use only visible evidence.",
  language: "English",
  brand_name: "Sara Clothes",
  brand_url: "https://example.test",
  banned_phrases: [],
  meta_description_min_chars: 150,
  meta_description_max_chars: 160,
};

function profile(overrides = {}) {
  return {
    brand: { value: "Sara Clothes", source: "shopify_vendor", confidence: 0.9 },
    colours: {
      primary: { value: "Mehndi Green", source: "image", confidence: 0.9 },
      secondary: { value: null, source: "unknown", confidence: 0 },
      contrast: { value: "Gold", source: "image", confidence: 0.8 },
    },
    fabric: {
      shirt: { value: "Organza", source: "shopify_description", confidence: 0.9 },
      dupatta: { value: "silk", source: "image", confidence: 0.95 },
      trouser: { value: null, source: "unknown", confidence: 0 },
    },
    neckline: {
      shape: { value: "v_neck", source: "image", confidence: 0.8 },
      embroidery: { value: "gold threadwork", source: "image", confidence: 0.9 },
      embellishments: { value: null, source: "unknown", confidence: 0 },
    },
    embroidery: {
      style: { value: "floral", source: "image", confidence: 0.7 },
      motifs: { value: null, source: "unknown", confidence: 0 },
      density: { value: null, source: "unknown", confidence: 0 },
      placement: { value: "front panel", source: "image", confidence: 0.8 },
    },
    shirt: { cut: null, silhouette: null, length: null, panels: null },
    sleeves: { length: null, shape: null, borders: null, embroidery: null },
    daman: { shape: null, lace: null, border: null, embroidery: null },
    dupatta: { colour: null, print: null, pattern: null, embroidery: null, fabric: null },
    trouser: { style: null, colour: null, embellishment: null },
    design_style: { value: "festive", source: "image", confidence: 0.75 },
    occasion: [{ value: "wedding", source: "image", confidence: 0.6 }],
    matching_keywords: [" Mehndi Green ", "gold embroidery", "#invalid"],
    metadata: { schema_version: 999, image_fingerprint: "forged" },
    ...overrides,
  };
}

test("normalizes profile facts and rejects image-only fabric and brand claims", () => {
  const normalized = normalizeDesignProfile(profile(), {
    imageFingerprint: "a".repeat(64),
    contextFingerprint: "b".repeat(64),
  });

  assert.equal(normalized.brand.value, "Sara Clothes");
  assert.equal(normalized.colours.primary.value, "Mehndi Green");
  assert.equal(normalized.fabric.shirt.value, "Organza");
  assert.equal(normalized.fabric.dupatta.value, null);
  assert.equal(normalized.neckline.shape.value, "v_neck");
  assert.deepEqual(normalized.matching_keywords, ["mehndi green", "gold embroidery"]);
  assert.equal(normalized.schema_version, 1);
  assert.equal(normalized.metadata.schema_version, 1);
  assert.equal(normalized.metadata.image_fingerprint, "a".repeat(64));
  assert.equal(normalized.metadata.source_fingerprint, "b".repeat(64));
  assert.ok(normalized.metadata.confidence >= 0 && normalized.metadata.confidence <= 1);

  const imageBrand = normalizeDesignProfile({
    brand: { value: "Sara Clothes", source: "image", confidence: 1 },
  });
  assert.equal(imageBrand.brand.value, null);
  assert.equal(imageBrand.brand.source, "unknown");

  const oversized = normalizeDesignProfile({
    shirt: { cut: { value: "x".repeat(181), source: "image", confidence: 1 } },
  });
  assert.equal(oversized.shirt.cut.value, null);
});

test("unknown profile input stays unknown and malformed roots are rejected", () => {
  const normalized = normalizeDesignProfile(nullProfile());
  assert.equal(normalized.daman.shape.value, null);
  assert.equal(normalized.daman.shape.source, "unknown");
  assert.throws(() => normalizeDesignProfile("not-json-object"), /JSON object/);
});

test("collection is the brand and old description prevents component fabric crossover", () => {
  const product = {
    title: "Kayseria E1998",
    vendor: "Sara Clothes",
    processingCollectionTitle: "Kayseria",
    descriptionHtml: `
      <p>Shirt Fabric: Lawn. Color: Yellow.</p>
      <p>Dupatta Fabric: Bamber Chiffon. Color: Yellow.</p>
      <p>Trouser Fabric: Cambric.</p>
    `,
  };
  const grounded = groundDesignProfileInput({
    brand: { value: "Sara Clothes", source: "shopify_vendor", confidence: 1 },
    fabric: {
      shirt: { value: "Lawn", source: "shopify_description", confidence: 1 },
      dupatta: { value: "Lawn", source: "shopify_description", confidence: 1 },
      trouser: { value: "Cambric", source: "shopify_description", confidence: 1 },
    },
    dupatta: {
      fabric: { value: "Bamber Chiffon", source: "shopify_description", confidence: 1 },
    },
    embroidery: {
      density: { value: "dense", source: "shopify_description", confidence: 1 },
    },
  }, product);
  const normalized = normalizeDesignProfile(grounded);

  assert.equal(resolveCollectionBrand(product), "Kayseria");
  assert.deepEqual(normalized.brand, {
    value: "Kayseria",
    source: "shopify_collection",
    confidence: 1,
  });
  assert.equal(normalized.fabric.shirt.value, "Lawn");
  assert.equal(normalized.fabric.dupatta.value, null);
  assert.equal(normalized.fabric.trouser.value, "Cambric");
  assert.equal(normalized.dupatta.fabric.value, "Bamber Chiffon");
  assert.equal(normalized.embroidery.density.value, null);
});

function nullProfile() {
  return { design_style: { value: "party", source: "image", confidence: 1 } };
}

test("image fingerprint uses fetched image bytes and stable JSON ignores key order", () => {
  const first = fingerprintImages([Buffer.from("image-a").toString("base64")]);
  const second = fingerprintImages([Buffer.from("image-b").toString("base64")]);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  const context = fingerprintProductContext({
    title: "Organza suit",
    options: [{ name: "Color", values: ["Green", "Gold"] }],
  });
  assert.equal(context, fingerprintProductContext({
    title: "Organza suit",
    options: [{ name: "Color", values: ["Gold", "Green"] }],
  }));
  assert.notEqual(context, fingerprintProductContext({
    title: "Changed title",
    options: [{ name: "Color", values: ["Green", "Gold"] }],
  }));
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
});

test("profile prompt is optional and includes Shopify Color option evidence", () => {
  const args = {
    promptConfig,
    product: {
      title: "Organza Festive Suit",
      vendor: "Sara Clothes",
      descriptionHtml: "<p>Organza fabric</p>",
      processingCollectionTitle: "Sapphire",
      options: [{ name: "Color", values: ["Mehndi Green", "Gold"] }],
    },
    designer: null,
    modelMatch: null,
  };
  const legacy = buildCombinedPromptText(args);
  assert.doesNotMatch(legacy, /design_profile/);
  const enabled = buildCombinedPromptText({ ...args, includeDesignProfile: true });
  assert.match(enabled, /design_profile/);
  assert.match(enabled, /\["Mehndi Green","Gold"\]/);
  assert.match(enabled, /Never claim a fabric from an image/);
  assert.match(enabled, /Collection\/brand: Sapphire/);
  assert.match(enabled, /shopify_collection/);
});

test("prompt keeps detailed pre-update description beyond the old 600 character cutoff", () => {
  const prompt = buildCombinedPromptText({
    promptConfig,
    product: {
      title: "Detailed Suit",
      processingCollectionTitle: "Kayseria",
      descriptionHtml: `<p>${"component detail ".repeat(50)}Bamber Chiffon Dupatta</p>`,
      options: [],
    },
    designer: null,
    modelMatch: null,
    includeDesignProfile: true,
  });
  assert.match(prompt, /Bamber Chiffon Dupatta/);
  assert.match(prompt, /roughly 160-260 words/);
});

test("malformed profile preserves successfully generated SEO fields", () => {
  const result = postProcessResult({
    description_html: "<p>Grounded product description.</p>",
    key_visual_detail: "gold embroidery",
    tags: ["embroidered suit"],
    image_alt_text: "Gold embroidered suit",
    design_profile: "malformed",
  }, {
    promptConfig,
    product: { title: "Organza Suit" },
    designer: null,
    modelMatch: null,
    includeDesignProfile: true,
  });

  assert.match(result.description_html, /Grounded product description/);
  assert.ok(result.meta_description.length > 0);
  assert.equal(result.design_profile, null);
  assert.match(result.design_profile_error, /JSON object/);
});
