"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeDesignProfile,
  fingerprintImages,
  fingerprintProductContext,
  stableJson,
} = require("../lib/designProfile");
const { buildCombinedPromptText, postProcessResult, validateDescriptionClaims } = require("../lib/promptShared");

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

test("accepts new provenance sources and preserves legacy schema sources", () => {
  const normalized = normalizeDesignProfile({
    brand: { value: "Imrozia", source: "collection", confidence: 1 },
    fabric: { shirt: { value: "lawn", source: "old_description", confidence: 0.9 } },
    shirt: { cut: { value: "straight", source: "title", confidence: 0.8 } },
  });
  assert.equal(normalized.schema_version, 1);
  assert.equal(normalized.brand.source, "collection");
  assert.equal(normalized.fabric.shirt.source, "old_description");
  assert.equal(normalized.shirt.cut.source, "title");
  assert.equal(normalizeDesignProfile(profile()).brand.source, "shopify_vendor");
});

test("rejects image-sourced fabric while retaining schema version 1", () => {
  const normalized = normalizeDesignProfile({
    fabric: { shirt: { value: "silk", source: "image", confidence: 1 } },
  });
  assert.equal(normalized.schema_version, 1);
  assert.equal(normalized.fabric.shirt.value, null);
  assert.equal(normalized.fabric.shirt.source, "unknown");
});

test("collection provenance is accepted and legacy vendor provenance remains valid", () => {
  const current = normalizeDesignProfile({ brand: { value: "Imrozia", source: "collection", confidence: 1 } });
  assert.equal(current.brand.value, "Imrozia");
  assert.equal(current.brand.source, "collection");
  assert.equal(current.schema_version, 1);
  assert.equal(normalizeDesignProfile(profile()).brand.source, "shopify_vendor");
});

test("description does not add Sara Clothes branding or a footer automatically", () => {
  const args = {
    promptConfig,
    product: { title: "Green Lawn Suit", vendor: "Sara Clothes", descriptionHtml: "<p>lawn</p>" },
    designer: null,
    modelMatch: null,
  };
  const prompt = buildCombinedPromptText(args);
  assert.doesNotMatch(prompt, /BRAND: Sara Clothes|closing line mentioning the brand/i);
  assert.match(prompt, /Do not automatically add the store brand “Sara Clothes”/);
  const verifiedBrandPrompt = buildCombinedPromptText({ ...args, product: { ...args.product, brandCollectionTitle: "Imrozia" } });
  assert.match(verifiedBrandPrompt, /Imrozia/);
  const result = postProcessResult({
    description_html: "<p>Imrozia green lawn with floral embroidery.</p><p>Sara Clothes</p>",
    key_visual_detail: "floral embroidery",
    tags: [], image_alt_text: "Green embroidered suit",
  }, { ...args, includeDesignProfile: false });
  assert.match(result.description_html, /Imrozia/);
  assert.doesNotMatch(result.description_html, /Sara Clothes|saraclothes\.com/i);
});

test("canonical description validation removes contradictory and ungrounded claims", () => {
  const profileFacts = normalizeDesignProfile({
    colours: { primary: { value: "green", source: "image", confidence: 0.9 } },
    fabric: { shirt: { value: null, source: "unknown", confidence: 0 } },
  });
  const html = "<p>Green embroidery is visible.</p><p>Red silk three-piece suit.</p>";
  const validated = validateDescriptionClaims(html, {
    profile: profileFacts,
    product: { title: "Embroidered suit", originalDescriptionHtml: "Detailed embroidery." },
  });
  assert.match(validated, /Green embroidery/);
  assert.doesNotMatch(validated, /Red silk|three-piece/);
});

test("claim validation preserves list wrappers around supported details", () => {
  const profileFacts = normalizeDesignProfile({
    colours: { primary: { value: "green", source: "image", confidence: 0.9 } },
  });
  const html = "<h2>Product Details</h2><ul><li>Green embroidery is visible.</li><li>Red silk three-piece suit.</li></ul>";
  const validated = validateDescriptionClaims(html, {
    profile: profileFacts,
    product: { title: "Embroidered garment", originalDescriptionHtml: "" },
  });
  assert.equal(validated, "<h2>Product Details</h2><ul><li>Green embroidery is visible.</li></ul>");
  assert.equal((validated.match(/<li>/g) || []).length, (validated.match(/<\/li>/g) || []).length);
  assert.equal((validated.match(/<ul>/g) || []).length, (validated.match(/<\/ul>/g) || []).length);
  assert.equal(validateDescriptionClaims("<h2>Unsupported</h2><ul><li>Red silk three-piece suit.</li></ul>", {
    profile: profileFacts,
    product: { title: "Embroidered garment", originalDescriptionHtml: "" },
  }), "");
});

test("prompt text is UTF-8 clean and contains no mojibake or BOM", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(require.resolve("../lib/promptShared"));
  assert.notEqual(source.subarray(0, 3).toString("hex"), "efbbbf");
  const text = source.toString("utf8");
  assert.doesNotMatch(text, /â€”|â€“|â€™|Ã|Â/);
  assert.match(text, /fashion-magazine copy/);
});

test("canonical prompt requires profile and description to share grounded facts", () => {
  const prompt = buildCombinedPromptText({
    promptConfig,
    product: { title: "Green Lawn Suit", originalDescriptionHtml: "lawn" },
    designer: null,
    modelMatch: null,
    includeDesignProfile: true,
  });
  assert.match(prompt, /normalized profile facts are the canonical fact set/i);
  assert.match(prompt, /Never claim fabric or suit-piece count from images/i);
  assert.match(prompt, /Verified brand collection/);
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
  assert.match(enabled, /Never claim fabric or suit-piece count from images/);
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
