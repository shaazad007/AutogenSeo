"use strict";

const crypto = require("crypto");

const SOURCES = new Set([
  "image",
  "shopify_title",
  "shopify_vendor",
  "shopify_description",
  "shopify_variant",
  "unknown",
]);

const NECKLINE_SHAPES = new Set([
  "round",
  "v_neck",
  "u_neck",
  "square",
  "boat",
  "collared",
  "unknown",
]);
const DAMAN_SHAPES = new Set(["straight", "curved", "scalloped", "unknown"]);
const DESIGN_STYLES = new Set([
  "casual",
  "formal",
  "festive",
  "traditional",
  "modern",
  "fusion",
  "unknown",
]);

const FACT = Symbol("fact");
const schema = {
  brand: FACT,
  colours: { primary: FACT, secondary: FACT, contrast: FACT },
  fabric: { shirt: FACT, dupatta: FACT, trouser: FACT },
  neckline: { shape: NECKLINE_SHAPES, embroidery: FACT, embellishments: FACT },
  embroidery: { style: FACT, motifs: FACT, density: FACT, placement: FACT },
  shirt: { cut: FACT, silhouette: FACT, length: FACT, panels: FACT },
  sleeves: { length: FACT, shape: FACT, borders: FACT, embroidery: FACT },
  daman: { shape: DAMAN_SHAPES, lace: FACT, border: FACT, embroidery: FACT },
  dupatta: { colour: FACT, print: FACT, pattern: FACT, embroidery: FACT, fabric: FACT },
  trouser: { style: FACT, colour: FACT, embellishment: FACT },
  design_style: DESIGN_STYLES,
  occasion: [FACT],
};

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeFact(value, path, allowedValues) {
  const source = plainObject(value) && SOURCES.has(value.source)
    ? value.source
    : "unknown";
  let text = plainObject(value) && typeof value.value === "string"
    ? value.value.trim().replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ")
    : "";
  let confidence = plainObject(value) && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : text
      ? 0.5
      : 0;

  const fabricPath = path.startsWith("fabric.") || path === "dupatta.fabric";
  const brandSourceAllowed = path !== "brand" ||
    ["shopify_title", "shopify_vendor"].includes(source);
  const fabricSourceAllowed = !fabricPath ||
    ["shopify_title", "shopify_description", "shopify_variant"].includes(source);
  const sourceAllowed = source !== "unknown" &&
    !(source === "image" && (fabricPath || path === "brand")) &&
    brandSourceAllowed && fabricSourceAllowed;
  if (!text || !sourceAllowed) {
    text = null;
    confidence = 0;
  }
  if (text && text.length > 180) {
    text = null;
    confidence = 0;
  }

  if (text && allowedValues && !allowedValues.has(text.toLowerCase())) {
    text = "unknown";
  }

  return {
    value: text,
    source: text === "unknown" ? "unknown" : text ? source : "unknown",
    confidence: text === "unknown" ? 0 : confidence,
  };
}

function normalizeNode(shape, value, path) {
  if (shape === FACT) return normalizeFact(value, path);
  if (shape instanceof Set) return normalizeFact(value, path, shape);
  if (Array.isArray(shape)) {
    const entries = Array.isArray(value) ? value : [];
    return entries
      .slice(0, 12)
      .map((entry, index) => normalizeNode(shape[0], entry, `${path}.${index}`))
      .filter((entry) => entry.value);
  }

  const raw = plainObject(value) ? value : {};
  return Object.fromEntries(
    Object.entries(shape).map(([key, child]) => [
      key,
      normalizeNode(child, raw[key], path ? `${path}.${key}` : key),
    ]),
  );
}

function collectFacts(value) {
  if (Array.isArray(value)) return value.flatMap(collectFacts);
  if (plainObject(value) && Object.hasOwn(value, "confidence")) return [value];
  if (plainObject(value)) return Object.values(value).flatMap(collectFacts);
  return [];
}

function normalizeDesignProfile(raw, {
  imageFingerprint = null,
  contextFingerprint = null,
} = {}) {
  if (!plainObject(raw)) {
    throw new TypeError("design_profile must be a JSON object.");
  }

  const profile = normalizeNode(schema, raw, "");
  profile.matching_keywords = Array.isArray(raw.matching_keywords)
    ? [...new Set(raw.matching_keywords
      .filter((item) => typeof item === "string")
      .map((item) => item.trim().toLowerCase().replace(/\s+/g, " "))
      .filter((item) => item.length >= 2 && item.length <= 48 && !item.includes("#")))].slice(0, 20)
    : [];

  const supportedFacts = collectFacts(profile).filter((fact) => fact.value);
  const confidence = supportedFacts.length
    ? supportedFacts.reduce((sum, fact) => sum + fact.confidence, 0) / supportedFacts.length
    : 0;
  profile.schema_version = 1;
  profile.metadata = {
    schema_version: 1,
    evidence_source: "ai_vision+shopify_product_context",
    confidence: Number(confidence.toFixed(3)),
    image_fingerprint: /^[a-f0-9]{64}$/i.test(imageFingerprint || "")
      ? imageFingerprint.toLowerCase()
      : null,
    source_fingerprint: /^[a-f0-9]{64}$/i.test(contextFingerprint || "")
      ? contextFingerprint.toLowerCase()
      : null,
  };
  return profile;
}

function fingerprintImages(base64Images) {
  const hash = crypto.createHash("sha256");
  for (const image of base64Images) {
    const bytes = Buffer.from(image, "base64");
    hash.update(String(bytes.length));
    hash.update(":");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function fingerprintProductContext(product = {}) {
  const options = (product.options || [])
    .map((option) => ({
      name: String(option.name || "").trim().toLowerCase(),
      values: [...(option.values || [])].map(String).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const context = {
    title: String(product.title || ""),
    vendor: String(product.vendor || ""),
    descriptionHtml: String(product.descriptionHtml || ""),
    tags: [...(product.tags || [])].map(String).sort(),
    options,
  };
  return crypto.createHash("sha256").update(stableJson(context)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  normalizeDesignProfile,
  fingerprintImages,
  fingerprintProductContext,
  stableJson,
};
