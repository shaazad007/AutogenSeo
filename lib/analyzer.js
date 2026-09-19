"use strict";

/**
 * Google Gemini vision wrapper.
 *
 * Uses the plain REST API (generativelanguage.googleapis.com) via fetch,
 * so no @google/generativeai SDK dependency is required — one less thing
 * to keep updated. Model names are read from config.json so they can be
 * changed without touching code as Google renames/retires models.
 *
 * Two-step pipeline (kept as two calls for reliability):
 *   1) analyzeImage(): image(s) + "detect" list -> structured JSON attributes
 *      ONLY of things actually visible. Nothing is invented.
 *   2) (see description.js) attributes + product context -> final SEO copy.
 */

const { retryWithBackoff, log } = require("./util");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

async function fetchImageAsBase64(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    const err = new Error(`Could not download image (${res.status}): ${imageUrl}`);
    err.status = res.status;
    throw err;
  }
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { base64: buffer.toString("base64"), mimeType: contentType.split(";")[0] };
}

function buildVisionPrompt(promptConfig, productContext) {
  const { detect, extra_rules, language } = promptConfig;

  return `You are a meticulous product photo analyst for an e-commerce catalog.

TASK: Look at the product image(s) below and identify ONLY what is clearly, visibly present.

Focus your attention on these aspects (comma-separated list, may not all apply — skip anything not visible or not applicable to this product type): ${detect}

Known context about this product (may be incomplete or slightly outdated — use it only as a hint, and to help you avoid re-describing things already stated):
- Title: ${productContext.title || "(unknown)"}
- Vendor: ${productContext.vendor || "(unknown)"}
- Existing description (plain text, may be empty): ${productContext.existingDescriptionText || "(none)"}

STRICT RULES:
- ${extra_rules}
- If something is not clearly visible, DO NOT mention it or guess. Leave it out entirely — do not write "not visible" either, just omit the field/point.
- Do not invent measurements, fabric names, materials, or technical specifications.
- Respond in ${language || "English"}.

Respond ONLY with a JSON object (no markdown, no commentary) in this exact shape:
{
  "product_type": "short phrase, e.g. 'unstitched suit', 'embroidered kurti', 'wireless earbuds'",
  "style": "traditional / modern / fusion / contemporary / not_applicable",
  "observed_details": ["short factual phrase", "short factual phrase", "..."],
  "colors": ["primary visible color", "..."],
  "confidence_notes": "one short sentence on anything ambiguous, or empty string"
}`;
}

async function analyzeImages(apiKey, model, imageUrls, promptConfig, productContext) {
  const parts = [{ text: buildVisionPrompt(promptConfig, productContext) }];

  for (const url of imageUrls.slice(0, 4)) {
    // cap at 4 images per product to control token/time cost
    try {
      const { base64, mimeType } = await fetchImageAsBase64(url);
      parts.push({ inline_data: { mime_type: mimeType, data: base64 } });
    } catch (err) {
      log(`Skipping unreachable image for analysis: ${err.message}`);
    }
  }

  if (parts.length === 1) {
    throw new Error("No product images could be downloaded for analysis.");
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json",
    },
  };

  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

  const data = await retryWithBackoff(
    async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(`Gemini vision request failed (${res.status}): ${JSON.stringify(json)}`);
        err.status = res.status;
        throw err;
      }
      return json;
    },
    { label: "Gemini image analysis" }
  );

  const text = data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;

  if (!text) {
    throw new Error("Gemini returned no analyzable content (possibly blocked by safety filters).");
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Could not parse Gemini vision JSON output: ${err.message}`);
  }
}

module.exports = { analyzeImages, fetchImageAsBase64 };
