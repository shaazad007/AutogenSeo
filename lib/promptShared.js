"use strict";

const { cleanText, truncate } = require("./util");
const { buildMetaDescription } = require("./metaTemplates");
const { pickRandomStyleDirective } = require("./styleTemplates");
const {
  normalizeDesignProfile,
  groundDesignProfileInput,
  fingerprintProductContext,
  resolveCollectionBrand,
} = require("./designProfile");

/**
 * The single prompt used for the combined vision+copy request, shared by
 * both Gemini and Groq so a mid-run provider switch never changes output
 * structure or house rules.
 *
 * NOTE: the AI is asked for "key_visual_detail", NOT a full meta
 * description anymore — the meta description is now built from templates
 * in code (see metaTemplates.js) using the title (brand + product name)
 * and this one short, visually-grounded detail phrase.
 */
function buildCombinedPromptText({
  promptConfig,
  product,
  designer,
  modelMatch,
  includeDesignProfile = false,
}) {
  const { detect, extra_rules, language, brand_name, banned_phrases } = promptConfig;
  const bannedList = (banned_phrases || []).join(", ");
  const existingDescriptionText = (product.descriptionHtml || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);
  const collectionBrand = resolveCollectionBrand(product);
  const productBrand = collectionBrand || brand_name;
  const styleDirective = pickRandomStyleDirective();
  const colorOptions = (product.options || [])
    .filter((option) => /^(color|colour)$/i.test(option.name || ""))
    .flatMap((option) => option.values || []);
  const designProfilePrompt = includeDesignProfile ? `

ALSO PRODUCE a structured design_profile using the same image inspection and this product context. Do not make a second analysis request. Each attribute is a fact object: {"value": string or null, "source": "image" | "shopify_title" | "shopify_vendor" | "shopify_collection" | "shopify_description" | "shopify_variant" | "unknown", "confidence": number from 0 to 1}. Use null, source "unknown", confidence 0 when unsupported.

EVIDENCE PRIORITY:
1. Treat the PRE-UPDATE SHOPIFY DESCRIPTION below as authoritative for explicitly stated fabric, component, colour, embroidery, measurements, and construction. It is the description that existed before this run changes anything.
2. Map every fabric to its named component. Never copy shirt fabric to dupatta or trouser. If the text says shirt lawn, dupatta chiffon, and trouser cambric, preserve those mappings exactly.
3. For colours, use component-specific old-description facts first, then Shopify Color/Colour variant options. Use image vision only when text and variant evidence are absent and the colour is clearly visible.
4. For neckline, sleeves, daman, motifs, cut, print, and visible embroidery, preserve explicit old-description facts first and use image vision only to fill missing visible facts.
5. Never claim a fabric from an image. Never replace an explicit text fact with an image guess. Never label an inferred adjective as shopify_description unless its exact wording exists in the old description.

The brand is the exact collection name "${collectionBrand || "(collection unavailable)"}" when available, with source "shopify_collection" and confidence 1. Only fall back to an explicit title/vendor brand when collection context is unavailable. Never overwrite or merge another product's data.

The design_profile keys and fact fields are exactly:
- brand
- colours: primary, secondary, contrast
- fabric: shirt, dupatta, trouser
- neckline: shape, embroidery, embellishments
- embroidery: style, motifs, density, placement
- shirt: cut, silhouette, length, panels
- sleeves: length, shape, borders, embroidery
- daman: shape, lace, border, embroidery
- dupatta: colour, print, pattern, embroidery, fabric
- trouser: style, colour, embellishment
- design_style
- occasion: array of fact objects
- matching_keywords: array of lowercase search phrases

Use these controlled values for neckline.shape: round, v_neck, u_neck, square, boat, collared, unknown. For daman.shape: straight, curved, scalloped, unknown. For design_style: casual, formal, festive, traditional, modern, fusion, unknown. Skip unsupported claims by returning the unknown fact form. Shopify Color/Colour options: ${JSON.stringify(colorOptions)}
` : "";
  const designProfileJsonMember = includeDesignProfile
    ? `,
  "design_profile": {
    "brand": {"value": null, "source": "unknown", "confidence": 0},
    "colours": {"primary": {"value": null, "source": "unknown", "confidence": 0}, "secondary": {"value": null, "source": "unknown", "confidence": 0}, "contrast": {"value": null, "source": "unknown", "confidence": 0}},
    "fabric": {"shirt": {"value": null, "source": "unknown", "confidence": 0}, "dupatta": {"value": null, "source": "unknown", "confidence": 0}, "trouser": {"value": null, "source": "unknown", "confidence": 0}},
    "neckline": {"shape": {"value": "unknown", "source": "unknown", "confidence": 0}, "embroidery": {"value": null, "source": "unknown", "confidence": 0}, "embellishments": {"value": null, "source": "unknown", "confidence": 0}},
    "embroidery": {"style": {"value": null, "source": "unknown", "confidence": 0}, "motifs": {"value": null, "source": "unknown", "confidence": 0}, "density": {"value": null, "source": "unknown", "confidence": 0}, "placement": {"value": null, "source": "unknown", "confidence": 0}},
    "shirt": {"cut": {"value": null, "source": "unknown", "confidence": 0}, "silhouette": {"value": null, "source": "unknown", "confidence": 0}, "length": {"value": null, "source": "unknown", "confidence": 0}, "panels": {"value": null, "source": "unknown", "confidence": 0}},
    "sleeves": {"length": {"value": null, "source": "unknown", "confidence": 0}, "shape": {"value": null, "source": "unknown", "confidence": 0}, "borders": {"value": null, "source": "unknown", "confidence": 0}, "embroidery": {"value": null, "source": "unknown", "confidence": 0}},
    "daman": {"shape": {"value": "unknown", "source": "unknown", "confidence": 0}, "lace": {"value": null, "source": "unknown", "confidence": 0}, "border": {"value": null, "source": "unknown", "confidence": 0}, "embroidery": {"value": null, "source": "unknown", "confidence": 0}},
    "dupatta": {"colour": {"value": null, "source": "unknown", "confidence": 0}, "print": {"value": null, "source": "unknown", "confidence": 0}, "pattern": {"value": null, "source": "unknown", "confidence": 0}, "embroidery": {"value": null, "source": "unknown", "confidence": 0}, "fabric": {"value": null, "source": "unknown", "confidence": 0}},
    "trouser": {"style": {"value": null, "source": "unknown", "confidence": 0}, "colour": {"value": null, "source": "unknown", "confidence": 0}, "embellishment": {"value": null, "source": "unknown", "confidence": 0}},
    "design_style": {"value": "unknown", "source": "unknown", "confidence": 0},
    "occasion": [],
    "matching_keywords": []
  }`
    : "";

  return `You are doing TWO jobs in one pass for an e-commerce catalog: (1) a meticulous product-photo analyst, then (2) a fashion editorial writer — the kind who writes for a fashion magazine, not a generic AI product blurb.

VOICE: Write the way fashion-magazine editorial copy reads — specific, observational, confident, varied sentence rhythm (mix short and long sentences), grounded in real visual detail rather than generic praise. Not gushing, not exclamation-heavy, not templated marketing-speak. This is about THIS product only — no celebrities, no runway shows, no other brands or collections. The product brand is "${productBrand}" and the product is always the one described below; never substitute or reference any other brand or product name.

STEP 1 — LOOK AT THE IMAGE(S) FIRST. Identify ONLY what is clearly, visibly present. Focus on: ${detect}
Do this silently — you do not need to output this step separately, just use it as the factual basis for step 2. If something is not clearly visible, do not mention it or guess — leave it out entirely.

STEP 2 — WRITE THE FINAL COPY using the authoritative pre-update description plus clearly visible image evidence. Preserve useful old facts, improve their organization and wording, and enrich them with visible design detail. Never add specifications, measurements, fabric names, or care instructions that were not confirmed.

PRODUCT CONTEXT:
- Title: ${product.title}
- Vendor: ${product.vendor || "(unknown)"}
- Collection/brand: ${collectionBrand || "(unavailable)"}
- PRE-UPDATE SHOPIFY DESCRIPTION (authoritative text evidence): ${existingDescriptionText || "(none)"}

${designer ? `DESIGNER (confirmed, you may name them): ${designer.name}` : "DESIGNER: none confirmed — do not name any designer."}
${modelMatch ? `MODEL/CELEBRITY (confirmed, may mention by name once): ${modelMatch.name}` : "MODEL/CELEBRITY: none confirmed — do NOT name or describe any person in the photo."}

BRAND: ${productBrand}
WRITE IN: ${language || "English"}

STRUCTURE for description_html this time (clean semantic HTML; if headings are used, start at H2/H3 since the theme already renders an H1 title) — follow this specific approach:
${styleDirective}

HARD RULES (apply regardless of which structure above is used):
- ${extra_rules}
- Never use these overused phrases or close variants: ${bannedList}.
- Vary sentence length — reflect what's actually different about THIS product, don't template it.
- No exclamation-mark-heavy marketing voice, no generic superlatives ("stunning", "must-have") unless visibly earned.
- Produce a substantial professional product description of roughly 160-260 words while following the chosen structure above. Clearly distinguish shirt, dupatta, and trouser facts in prose or, when that structure allows lists, in a concise HTML list.
- Preserve exact component fabrics, colours, embroidery details, and measurements from the pre-update description. Use images to add visible design observations, never to invent material specifications.
- Do not append a store-brand footer, "Sara Clothes" sign-off, or store URL to description_html.

Also produce:
- "key_visual_detail": ONE short, factual, lowercase phrase (3-6 words, max ~35 characters) naming the single most distinctive thing you can actually see — e.g. "floral embroidery", "vertical stripe pattern", "tassel detailing on neckline". This must be visibly true — never invented. This is used elsewhere, not shown verbatim in the description.
- "tags": an array of 6-10 relevant SEO tags (lowercase, no # symbol), based only on confirmed attributes + product type + designer name if confirmed.
- "image_alt_text": a single reusable alt text template (max 125 characters) describing the product generically for its images, e.g. "Embroidered festive kurti with round neckline by ${designer ? designer.name : brand_name}".
${designProfilePrompt}

Respond ONLY with a JSON object, no markdown fences, in this exact shape:
{
  "description_html": "<p>...</p>...",
  "key_visual_detail": "...",
  "tags": ["...", "..."],
  "image_alt_text": "..."${designProfileJsonMember}
}`;
}

/**
 * Shared post-processing for either provider's raw JSON response:
 * - enforces length limits in code (never trusts the model on this)
 * - builds the meta description from templates (title + key_visual_detail)
 * - inserts confirmed designer collection and model Instagram links
 *   directly in code — these are NEVER generated by the model
 */
function postProcessResult(result, {
  promptConfig,
  product,
  designer,
  modelMatch,
  includeDesignProfile = false,
  imageFingerprint = null,
}) {
  result.description_html = cleanText(result.description_html);
  result.tags = Array.isArray(result.tags) ? result.tags.slice(0, 10) : [];
  result.image_alt_text = truncate(cleanText(result.image_alt_text), 125);

  result.meta_description = buildMetaDescription({
    title: product.title,
    detail: result.key_visual_detail,
    fallbackBrand: promptConfig.brand_name,
    minChars: promptConfig.meta_description_min_chars || 150,
    maxChars: promptConfig.meta_description_max_chars || 160,
  });

  if (includeDesignProfile) {
    try {
      const groundedProfile = groundDesignProfileInput(result.design_profile, product);
      result.design_profile = normalizeDesignProfile(groundedProfile, {
        imageFingerprint,
        contextFingerprint: fingerprintProductContext(product),
      });
      delete result.design_profile_error;
    } catch (error) {
      result.design_profile = null;
      result.design_profile_error = error.message;
    }
  } else {
    delete result.design_profile;
    delete result.design_profile_error;
  }

  let html = result.description_html;

  if (designer && designer.collection_url && html.includes(designer.name)) {
    const headingRegex = new RegExp(`(<h2[^>]*>)(\\s*${designer.name}[^<]*)(</h2>)`, "i");
    if (headingRegex.test(html)) {
      html = html.replace(headingRegex, `$1<a href="${designer.collection_url}">$2</a>$3`);
    } else {
      // This structure variant didn't use an H2 heading — link the first
      // plain-text mention of the designer's name instead, so the
      // collection link still lands regardless of which style was picked.
      html = html.replace(designer.name, `<a href="${designer.collection_url}">${designer.name}</a>`);
    }
  }

  if (modelMatch && modelMatch.instagram && html.includes(modelMatch.name)) {
    html = html.replace(modelMatch.name, `<a href="${modelMatch.instagram}" rel="nofollow">${modelMatch.name}</a>`);
  }

  result.description_html = html;
  result.designer_matched = designer ? designer.name : null;
  result.model_matched = modelMatch ? modelMatch.name : null;

  return result;
}

module.exports = { buildCombinedPromptText, postProcessResult };
