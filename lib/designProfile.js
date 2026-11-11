"use strict";

const crypto = require("crypto");

const SOURCES = new Set([
  "image",
  "shopify_title",
  "shopify_vendor",
  "shopify_collection",
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
    ["shopify_title", "shopify_vendor", "shopify_collection"].includes(source);
  const collectionSourceAllowed = source !== "shopify_collection" || path === "brand";
  const fabricSourceAllowed = !fabricPath ||
    ["shopify_title", "shopify_description", "shopify_variant"].includes(source);
  const sourceAllowed = source !== "unknown" &&
    !(source === "image" && (fabricPath || path === "brand")) &&
    brandSourceAllowed && fabricSourceAllowed && collectionSourceAllowed;
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

function normalizeEvidenceText(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:[a-z]+|#\d+|#x[a-f0-9]+);/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function collectionCandidates(product = {}) {
  const explicit = String(product.processingCollectionTitle || "").trim();
  const nodes = product.collections && Array.isArray(product.collections.nodes)
    ? product.collections.nodes
    : [];
  const titles = nodes.map((node) => String(node && node.title || "").trim()).filter(Boolean);
  return [...new Set([explicit, ...titles].filter(Boolean))];
}

function resolveCollectionBrand(product = {}) {
  const candidates = collectionCandidates(product);
  if (!candidates.length) return null;
  if (product.processingCollectionTitle) return candidates[0];

  const productTitle = normalizeEvidenceText(product.title);
  const vendor = normalizeEvidenceText(product.vendor);
  const matchingTitle = candidates.find((title) => {
    const normalized = normalizeEvidenceText(title);
    return normalized && (productTitle === normalized || productTitle.startsWith(`${normalized} `));
  });
  if (matchingTitle) return matchingTitle;
  const matchingVendor = candidates.find((title) => normalizeEvidenceText(title) === vendor);
  return matchingVendor || candidates.slice().sort((a, b) => a.localeCompare(b))[0];
}

function componentEvidenceSegment(descriptionText, component) {
  const marker = new RegExp(`\\b${component}\\b`, "ig");
  const otherComponents = ["shirt", "dupatta", "trouser"].filter((name) => name !== component);
  const segments = [];
  for (let match = marker.exec(descriptionText); match; match = marker.exec(descriptionText)) {
    let end = descriptionText.length;
    for (const other of otherComponents) {
      const next = new RegExp(`\\b${other}\\b`, "ig");
      next.lastIndex = match.index + match[0].length;
      const nextMatch = next.exec(descriptionText);
      if (nextMatch && nextMatch.index < end) end = nextMatch.index;
    }
    segments.push(descriptionText.slice(match.index, end));
  }
  return segments.join(" ");
}

function groundDesignProfileInput(raw, product = {}) {
  if (!plainObject(raw)) return raw;
  const grounded = JSON.parse(JSON.stringify(raw));
  const description = normalizeEvidenceText(product.descriptionHtml);
  const componentPaths = new Map([
    ["fabric.shirt", "shirt"],
    ["fabric.dupatta", "dupatta"],
    ["fabric.trouser", "trouser"],
    ["dupatta.fabric", "dupatta"],
    ["dupatta.colour", "dupatta"],
    ["trouser.colour", "trouser"],
  ]);

  function visit(value, path = "") {
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, `${path}.${index}`));
    if (!plainObject(value)) return value;
    if (Object.hasOwn(value, "source") && Object.hasOwn(value, "value")) {
      if (value.source !== "shopify_description" || typeof value.value !== "string") return value;
      const expected = normalizeEvidenceText(value.value);
      const component = componentPaths.get(path);
      const evidence = component ? componentEvidenceSegment(description, component) : description;
      if (expected && evidence.includes(expected)) return value;
      return { value: null, source: "unknown", confidence: 0 };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      visit(child, path ? `${path}.${key}` : key),
    ]));
  }

  const visited = visit(grounded);
  const collectionBrand = resolveCollectionBrand(product);
  if (collectionBrand) {
    visited.brand = {
      value: collectionBrand,
      source: "shopify_collection",
      confidence: 1,
    };
  }
  return visited;
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
    collectionBrand: resolveCollectionBrand(product),
    collections: collectionCandidates(product).slice().sort(),
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
  groundDesignProfileInput,
  resolveCollectionBrand,
  fingerprintImages,
  fingerprintProductContext,
  stableJson,
};
