"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { selectLayoutFamily, getLayoutDirective, renderDescriptionContent } = require("../lib/styleTemplates");
const { buildMetaDescription } = require("../lib/metaTemplates");
const { buildCombinedPromptText, postProcessResult, sanitizeLegacyDescription } = require("../lib/promptShared");

const config = {
  detect: "visible colours, embroidery, neckline, silhouette",
  extra_rules: "Use confirmed evidence only.",
  language: "English",
  brand_name: "Sara Clothes",
  banned_phrases: [],
  meta_description_min_chars: 140,
  meta_description_max_chars: 160,
};

test("layout selection is stable by product ID and varies across products", () => {
  const product = { id: "gid://shopify/Product/123", handle: "green-suit" };
  assert.deepEqual(selectLayoutFamily(product), selectLayoutFamily(product));
  const families = new Set(Array.from({ length: 20 }, (_, i) => selectLayoutFamily({ id: `product-${i}` }).id));
  assert.equal(families.size, 5);
  assert.match(getLayoutDirective(product), /deterministically/);
});

test("structured content renders semantic HTML without empty headings or unsafe markup", () => {
  const html = renderDescriptionContent({
    intro: "Green fabric with <script>alert(1)</script> visible embroidery.",
    design_summary: "Gold floral embroidery follows the front panel.",
    feature_bullets: ["V neckline", "<img src=x onerror=alert(1)>"],
  }, { id: "product-0" });
  assert.match(html, /<p>/);
  assert.match(html, /<h2>/);
  assert.match(html, /<ul><li>/);
  assert.doesNotMatch(html, /<h1|<h3|<script|<img|<h2>\s*<\/h2>/i);
  assert.equal((html.match(/<li>/g) || []).length, (html.match(/<\/li>/g) || []).length);
  assert.equal((html.match(/<ul>/g) || []).length, (html.match(/<\/ul>/g) || []).length);
});

test("legacy HTML fallback removes H1 and wraps orphan list items", () => {
  const html = sanitizeLegacyDescription("<h1>Product</h1><li>Visible detail</li>");
  assert.equal(html, "<h2>Product</h2><ul><li>Visible detail</li></ul>");
  assert.doesNotMatch(html, /<h1|<li>(?![\s\S]*<\/ul>)/i);
});

test("prompt requests structured content, one stable voice, and supplier rewriting", () => {
  const prompt = buildCombinedPromptText({
    promptConfig: config,
    product: { id: "1", title: "Green Organza Suit", descriptionHtml: "Supplier original wording." },
    designer: null,
    modelMatch: null,
    includeDesignProfile: true,
  });
  assert.match(prompt, /description_content/);
  assert.match(prompt, /never copy its wording/i);
  assert.match(prompt, /fashion-magazine copy/);
  assert.match(prompt, /Do not automatically add the store brand/);
});

test("meta description is factual and never falls back to the store brand", () => {
  const first = buildMetaDescription({ title: "Embroidered Lawn Suit", detail: "gold floral embroidery", fallbackBrand: "Sara Clothes" });
  const second = buildMetaDescription({ title: "Embroidered Lawn Suit", detail: "gold floral embroidery", fallbackBrand: "Sara Clothes" });
  assert.equal(first, second);
  assert.match(first, /Embroidered Lawn Suit/);
  assert.match(first, /gold floral embroidery/);
  assert.doesNotMatch(first, /Sara Clothes|shipped|premium quality|must-have|stunning/i);
});

test("post-processing renders structured content and strips store name from alt text", () => {
  const result = postProcessResult({
    description_content: { intro: "Green with gold embroidery." },
    key_visual_detail: "gold embroidery",
    tags: [],
    image_alt_text: "Green suit by Sara Clothes",
  }, {
    promptConfig: config,
    product: { id: "1", title: "Green Embroidered Suit" },
    designer: null,
    modelMatch: null,
  });
  assert.equal(result.description_html, "<p>Green with gold embroidery.</p>");
  assert.doesNotMatch(result.description_html + result.image_alt_text + result.meta_description, /Sara Clothes/i);
});
