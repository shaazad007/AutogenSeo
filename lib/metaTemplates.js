"use strict";

/**
 * Template-based meta description generation.
 *
 * WHY THIS EXISTS: instead of asking the AI to freely write the meta
 * description every time (which drifts in length, tone, and can end up
 * sounding too similar across thousands of products — the exact "thin/
 * duplicate content" problem that was hurting Google indexing), we:
 *   1) Parse the brand and product name directly from the product title
 *      in code (deterministic, zero AI guessing — brand names are wrong
 *      0% of the time this way instead of relying on the model).
 *   2) Take ONE short, visually-grounded detail phrase from the AI
 *      (e.g. "floral embroidery", "vertical stripe pattern").
 *   3) Drop those into one of 18 hand-written, SEO-oriented templates,
 *      chosen at random per product, so the catalog has real variety
 *      instead of every meta description reading identically.
 *
 * Templates are written for an international audience (Pakistan, UK,
 * USA, Canada) — natural English, not over-localized slang, with about
 * half mentioning international shipping/availability (the rest focus on
 * the product itself, so it doesn't read as keyword-stuffed).
 */

const { truncate } = require("./util");

const TEMPLATES = [
  "Shop the {brand} {product} online — featuring {detail}. Premium quality fashion, fast shipping to Pakistan, USA, UK & Canada.",
  "{brand} {product} featuring {detail}. Elegant style for weddings, festivals and everyday occasions. Order online today, worldwide.",
  "Discover {brand}'s {product} with {detail}. Trusted craftsmanship, worldwide shipping, easy returns — shop the full collection now.",
  "{product} by {brand} — a {detail} design perfect for festive and everyday wear. Shop the complete collection online today.",
  "Get the {brand} {product} online — showcasing {detail}. Fast, reliable delivery across the USA, UK, Canada and Pakistan.",
  "{brand} presents the {product}, thoughtfully crafted with {detail}. Timeless style, carefully packaged and delivered to your door.",
  "Own the {brand} {product} today — {detail} that genuinely stands out. International shipping available, easy online checkout.",
  "{product} from {brand}: {detail} for a refined, elegant everyday look. Shop the collection now with worldwide home delivery.",
  "Explore {brand}'s {product} — {detail} you can see and feel. Authentic craftsmanship, shipped internationally, quality guaranteed.",
  "{brand} {product} online — a {detail} design made for special occasions. Available with delivery across USA, UK, Canada & Pakistan.",
  "Add the {product} by {brand} to your wardrobe — {detail}, dependable quality you can trust, shipped globally in days.",
  "{brand} {product} — finished with {detail}. Shop premium everyday and festive fashion, with fast international delivery included.",
  "Looking for {product}? {brand} delivers {detail} and dependable quality. Ships internationally to Pakistan, UK, USA and Canada.",
  "{product} by {brand}: {detail} craftsmanship made for the modern wardrobe. Order today, with tracked worldwide shipping available.",
  "New arrival: the {brand} {product}, featuring {detail}. Elegant, comfortable, and shipped worldwide with reliable tracking.",
  "{brand}'s {product} brings {detail} into your everyday closet. Trusted by shoppers across Pakistan, the UK, USA and Canada.",
  "Shop the {product} by {brand} — {detail} you'll genuinely love wearing. Fast international shipping, secure checkout, easy returns.",
  "{brand} {product}: {detail} for effortless everyday style. Order now, with worldwide delivery and dedicated customer support.",
];

/**
 * Deterministically split a product title into brand + product name.
 * Pattern observed across this catalog: brand is the leading run of
 * pure-alphabetic word(s), then a style code/number starts (e.g.
 * "Khaadi J20221 Yellow..." -> brand "Khaadi"; "Maria B DW-W26-56-..."
 * -> brand "Maria B"; "Auj D-15 Fleur De Lux 2021" -> brand "Auj").
 */
function extractBrandAndProduct(title, fallbackBrand) {
  const words = String(title || "").trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return { brand: fallbackBrand || "", product: title || "" };
  }

  let splitIndex = -1;
  for (let i = 0; i < words.length; i++) {
    if (/\d/.test(words[i])) {
      splitIndex = i;
      break;
    }
  }

  // No digit-containing word anywhere in the title — can't reliably split
  // it into brand + product, so don't guess: use the fallback brand and
  // keep the whole title as the product name.
  if (splitIndex === -1) {
    return { brand: fallbackBrand || "", product: title };
  }

  // The very first word already contains a digit — no leading brand word.
  if (splitIndex === 0) {
    return { brand: fallbackBrand || "", product: title };
  }

  const brand = words.slice(0, splitIndex).join(" ").trim();
  const product = words.slice(splitIndex).join(" ").trim() || title;

  return { brand, product };
}

function renderTemplate(template, { brand, product, detail }) {
  return template
    .replace(/\{brand\}/g, brand)
    .replace(/\{product\}/g, product)
    .replace(/\{detail\}/g, detail)
    .replace(/\s+/g, " ")
    .trim();
}

function shuffledIndices(length) {
  const arr = Array.from({ length }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Build a meta description for one product.
 * title: the product's Shopify title (used to parse brand + product name).
 * detail: a short, AI-provided, visually-grounded phrase (may be empty).
 * fallbackBrand: promptConfig.brand_name, used only if title parsing fails.
 */
function buildMetaDescription({ title, detail, fallbackBrand, minChars = 150, maxChars = 160 }) {
  const { brand, product } = extractBrandAndProduct(title, fallbackBrand);
  const cleanDetail = (detail || "distinctive design details").trim();
  const cappedProduct = truncate(product, 45);

  let best = null;

  for (const idx of shuffledIndices(TEMPLATES.length)) {
    const rendered = renderTemplate(TEMPLATES[idx], { brand, product: cappedProduct, detail: cleanDetail });
    const len = rendered.length;

    if (len >= minChars && len <= maxChars) {
      return rendered; // clean fit — use it
    }

    // Track the closest-fitting candidate in case nothing lands perfectly in range.
    const distance = len > maxChars ? len - maxChars : minChars - len;
    if (!best || distance < best.distance) {
      best = { rendered, len, distance };
    }
  }

  // Nothing landed perfectly in range — use the closest fit, trimmed to maxChars.
  return best.len > maxChars ? truncate(best.rendered, maxChars) : best.rendered;
}

module.exports = { buildMetaDescription, extractBrandAndProduct, TEMPLATES };
