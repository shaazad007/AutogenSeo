"use strict";

const { truncate } = require("./util");

function buildMetaDescription({ title, detail, maxChars = 160 }) {
  // The title is verified Shopify data. Never add the store name as a fallback brand.
  const product = clean(title) || "Product";
  const visualDetail = clean(detail);
  const sentence = visualDetail
    ? `${product} features ${visualDetail}. View product details and available options.`
    : `${product}. View product details and available options.`;
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 160;
  const result = truncate(sentence, cap).replace(/[\s,;:.!?-]+$/g, "").trim();
  // Character targets are advisory. Keep a short, factual sentence instead of padding it.
  return result;
}

function clean(value) {
  return String(value || "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, " ").replace(/Sara Clothes|saraclothes\.com/gi, " ")
    .replace(/\s+/g, " ").trim();
}

function extractBrandAndProduct(title, fallbackBrand) {
  const value = clean(title);
  if (!value) return { brand: "", product: fallbackBrand || "" };
  const words = value.split(/\s+/);
  const splitIndex = words.findIndex((word) => /\d/.test(word));
  if (splitIndex <= 0) return { brand: "", product: value };
  return { brand: words.slice(0, splitIndex).join(" "), product: words.slice(splitIndex).join(" ") || value };
}

module.exports = { buildMetaDescription, extractBrandAndProduct, TEMPLATES: [] };
