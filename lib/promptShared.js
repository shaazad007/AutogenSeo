"use strict";

const { cleanText, truncate } = require("./util");
const { buildMetaDescription } = require("./metaTemplates");
const { getLayoutDirective, renderDescriptionContent } = require("./styleTemplates");
const {
  normalizeDesignProfile,
  fingerprintProductContext,
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
  const { detect, extra_rules, language, banned_phrases } = promptConfig;
  const bannedList = (banned_phrases || []).join(", ");
  const existingDescriptionText = (product.originalDescriptionHtml || product.descriptionHtml || "").replace(/<[^>]*>/g, " ").slice(0, 600);
  const styleDirective = getLayoutDirective(product);
  const colorOptions = (product.options || [])
    .filter((option) => /^(color|colour)$/i.test(option.name || ""))
    .flatMap((option) => option.values || []);
  const designProfilePrompt = includeDesignProfile ? `

ALSO PRODUCE a structured design_profile using the same image inspection and this product context. Do not make a second analysis request. The normalized profile facts are the canonical fact set; the description must use those same facts plus verified original-description/title facts and must not introduce extra product claims. Each attribute is a fact object: {"value": string or null, "source": "image" | "collection" | "old_description" | "title" | "shopify_title" | "shopify_vendor" | "shopify_description" | "shopify_variant" | "unknown", "confidence": number from 0 to 1}. Use null, source "unknown", confidence 0 when unsupported. Never claim fabric or suit-piece count from images. Fabric and piece count may only come from verified original description/title; otherwise omit and leave unknown. Brand uses a verified brand collection when supplied, otherwise vendor. Use Shopify Color/Colour option values before estimating colors from the image. Never overwrite or merge another product's data.

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

VOICE: Write specific, polished, factual professional fashion-magazine copy in one stable editorial/catalog voice. Never add a fictional scene, rhetorical question, sales pitch, unsupported occasion, comfort/feel/drape claim, or store brand. Do not automatically add the store brand “Sara Clothes” or its link. A verified product/collection brand or confirmed designer may be mentioned when supplied in the product context; never invent or substitute a brand.

STEP 1 — LOOK AT THE IMAGE(S) FIRST. Identify ONLY what is clearly, visibly present. Focus on: ${detect}
Do this silently — you do not need to output this step separately, just use it as the factual basis for step 2. If something is not clearly visible, do not mention it or guess — leave it out entirely.

STEP 2 — WRITE THE FINAL COPY, grounded ONLY in visible facts and the verified product context below. The original supplier description is evidence only: rewrite facts in original language; never copy its wording. Never add specifications, measurements, fabric names unless verified in product text, piece count unless verified in product text, or care instructions that weren't confirmed.

PRODUCT CONTEXT:
- Title: ${product.title}
- Vendor: ${product.vendor || "(unknown)"}
- Verified original description (reuse supported fabric and set-piece details; never infer fabric from images): ${existingDescriptionText || "(none)"}
- Verified brand collection: ${product.brandCollectionTitle || "(none; use vendor if available)"}

${designer ? `DESIGNER (confirmed, you may name them): ${designer.name}` : "DESIGNER: none confirmed — do not name any designer."}
${modelMatch ? `MODEL/CELEBRITY (confirmed, may mention by name once): ${modelMatch.name}` : "MODEL/CELEBRITY: none confirmed — do NOT name or describe any person in the photo."}

WRITE IN: ${language || "English"}

DETERMINISTIC STRUCTURE for description_content fields (the application renders semantic HTML):
${styleDirective}

DESCRIPTION_CONTENT fields: intro is the opening paragraph; design_summary covers the overall garment design; fabric_components contains only verified fabrics and included components; visual_details describes visible colour, pattern, silhouette, neckline, sleeves, embroidery, and finishing; styling_note is optional and factual; feature_bullets and component_bullets contain concise verified facts. Return plain text only, no HTML. Use empty strings or arrays for unsupported content.

HARD RULES (apply regardless of which structure above is used):
- ${extra_rules}
- Never use these overused phrases or close variants: ${bannedList}.
- Do not repeat generic openings such as “This design”, “This outfit”, “This suit”, “The overall design”, or “The shirt features”. Lead with a verified colour, craft, silhouette, pattern, or distinctive detail when available.
- Do not use generic superlatives, sales language, unsupported styling advice, or keyword stuffing.

Also produce:
- "key_visual_detail": ONE short, factual, lowercase phrase (3-6 words, max ~35 characters) naming the single most distinctive thing you can actually see — e.g. "floral embroidery", "vertical stripe pattern", "tassel detailing on neckline". This must be visibly true — never invented. This is used elsewhere, not shown verbatim in the description.
- "tags": an array of 6-10 relevant SEO tags (lowercase, no # symbol), based only on confirmed attributes + product type + designer name if confirmed.
- "image_alt_text": a single reusable alt text template (max 125 characters) describing only verified visible product details. Mention a product brand only when verified; never add the store brand.
${designProfilePrompt}

Respond ONLY with a JSON object, no markdown fences, in this exact shape:
{
  "description_content": {
    "intro": "",
    "design_summary": "",
    "fabric_components": "",
    "visual_details": "",
    "styling_note": "",
    "feature_bullets": [],
    "component_bullets": []
  },
  "key_visual_detail": "...",
  "tags": ["...", "..."],
  "image_alt_text": "..."${designProfileJsonMember}
}`;
}

/**
 * Shared post-processing for either provider's raw JSON response:
 * - enforces length limits in code (never trusts the model on this)
 * - builds a factual meta description from the verified title and key visual detail
 * - inserts designer collection link / model Instagram link / brand link
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
  result.description_html = result.description_content && typeof result.description_content === "object"
    ? renderDescriptionContent(result.description_content, product)
    : sanitizeLegacyDescription(result.description_html);
  result.description_html = cleanText(result.description_html);
  result.description_html = removeStoreBrand(result.description_html);
  result.tags = Array.isArray(result.tags) ? result.tags.slice(0, 10) : [];
  result.image_alt_text = truncate(cleanText(removeStoreBrand(result.image_alt_text)), 125);

  result.meta_description = buildMetaDescription({
    title: product.title,
    detail: result.key_visual_detail,
    maxChars: promptConfig.meta_description_max_chars || 160,
  });

  if (includeDesignProfile) {
    try {
      result.design_profile = normalizeDesignProfile(result.design_profile, {
        imageFingerprint,
        contextFingerprint: fingerprintProductContext(product),
      });
      delete result.design_profile_error;
    } catch (error) {
      result.design_profile = null;
      result.design_profile_error = error.message;
    }
    if (result.design_profile) {
      result.description_html = validateDescriptionClaims(result.description_html, {
        profile: result.design_profile,
        product,
      });
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

function validateDescriptionClaims(html, { profile, product }) {
  const verifiedContext = `${product.title || ""} ${product.originalDescriptionHtml || product.descriptionHtml || ""}`
    .replace(/<[^>]*>/g, " ").toLowerCase();
  const fabricFacts = [
    profile.fabric?.shirt, profile.fabric?.dupatta, profile.fabric?.trouser,
    profile.dupatta?.fabric,
  ].filter((fact) => fact?.value && fact.source !== "unknown").map((fact) => fact.value.toLowerCase());
  const colours = [
    profile.colours?.primary, profile.colours?.secondary, profile.colours?.contrast,
    profile.dupatta?.colour, profile.trouser?.colour,
  ].filter((fact) => fact?.value && fact.source !== "unknown").map((fact) => fact.value.toLowerCase());
  const knownFabrics = ["lawn", "cotton", "silk", "chiffon", "organza", "cambric", "linen", "velvet", "georgette", "net", "khaddar", "karandi", "viscose", "voile", "satin"];
  const colorWords = ["black", "white", "ivory", "cream", "beige", "brown", "red", "maroon", "pink", "rose", "orange", "yellow", "mustard", "green", "olive", "teal", "blue", "navy", "purple", "lavender", "grey", "gray", "gold", "silver"];
  const blockRegex = /<(p|li|h[2-6])\b[^>]*>[\s\S]*?<\/\1>/gi;
  const validated = String(html || "").replace(blockRegex, (block) => {
    const text = block.replace(/<[^>]*>/g, " ").toLowerCase();
    const unverifiedFabric = knownFabrics.some((fabric) =>
      new RegExp(`\\b${fabric}\\b`, "i").test(text) &&
      !new RegExp(`\\b${fabric}\\b`, "i").test(verifiedContext) &&
      !fabricFacts.some((fact) => fact.includes(fabric)));
    const unsupportedPieceCount = /\b(?:two|three|four|five|2|3|4|5)[ -]piece\b/i.test(text) &&
      !/\b(?:two|three|four|five|2|3|4|5)[ -]piece\b/i.test(verifiedContext);
    const unsupportedColour = colorWords.some((colour) =>
      new RegExp(`\\b${colour}\\b`, "i").test(text) &&
      !new RegExp(`\\b${colour}\\b`, "i").test(verifiedContext) &&
      !colours.some((fact) => fact.includes(colour)));
    return unverifiedFabric || unsupportedPieceCount || unsupportedColour ? "" : block;
  });
  return validated
    .replace(/<ul\b[^>]*>\s*<\/ul>/gi, "")
    .replace(/<h[2-6]\b[^>]*>\s*<\/h[2-6]>/gi, "")
    .replace(/<h[2-6]\b[^>]*>[\s\S]*?<\/h[2-6]>\s*(?=<h[2-6]\b|$)/gi, "");
}

function removeStoreBrand(html) {
  return String(html || "")
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (link) =>
      /Sara Clothes|saraclothes\.com/i.test(link) ? "" : link)
    .replace(/<(p|li|h[2-6])\b[^>]*>[\s\S]*?<\/\1>/gi, (block) =>
      /Sara Clothes|saraclothes\.com/i.test(block) ? "" : block)
    .replace(/saraclothes\.com/gi, "")
    .replace(/Sara Clothes/gi, "")
    .replace(/\s{2,}/g, " ");
}

function sanitizeLegacyDescription(html) {
  let value = String(html || "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<h1\b[^>]*>/gi, "<h2>").replace(/<\/h1>/gi, "</h2>")
    .replace(/<h[3-6]\b[^>]*>/gi, "<h2>").replace(/<\/h[3-6]>/gi, "</h2>")
    .replace(/<a\b[^>]*>/gi, "").replace(/<\/a>/gi, "")
    .replace(/\s+(?:style|class|id|onclick)=(?:"[^"]*"|'[^']*')/gi, "");
  const tags = value.match(/<\/?(?:ul|li)\b[^>]*>/gi) || [];
  let inList = false;
  for (const tag of tags) {
    if (/^<ul\b/i.test(tag)) inList = true;
    else if (/^<\/ul/i.test(tag)) inList = false;
    else if (/^<li\b/i.test(tag) && !inList) {
      value = value.replace(tag, `<ul>${tag}`);
      inList = true;
    } else if (/^<\/li/i.test(tag) && inList) {
      const next = value.indexOf(tag) + tag.length;
      if (!/^\s*<li\b|^\s*<\/ul\b/i.test(value.slice(next))) {
        value = value.slice(0, next) + "</ul>" + value.slice(next);
        inList = false;
      }
    }
  }
  return value.replace(/<\/?(?!p\b|h2\b|ul\b|li\b|strong\b)[a-z][^>]*>/gi, "");
}

module.exports = { buildCombinedPromptText, postProcessResult, validateDescriptionClaims, removeStoreBrand, sanitizeLegacyDescription };
