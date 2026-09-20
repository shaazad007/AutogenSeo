"use strict";

/**
 * Gemini (primary) provider — single combined call per product.
 * See lib/promptShared.js for the shared prompt/post-processing, and
 * lib/groq.js for the automatic fallback provider used when Gemini's
 * daily quota is exhausted.
 */

const { retryWithBackoff, log } = require("./util");
const { fetchImageAsBase64 } = require("./analyzer");
const { findMatch } = require("./description");
const { buildCombinedPromptText, postProcessResult } = require("./promptShared");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

async function generateProductContent({ apiKey, visionModel, textModel, product, imageUrls, promptConfig, designers, models }) {
  const model = visionModel || textModel;

  const haystack = [product.title, product.vendor, ...(product.tags || [])].join(" ");
  const designer = findMatch(designers, haystack);
  const modelMatch = findMatch(models, haystack);

  const parts = [{ text: buildCombinedPromptText({ promptConfig, product, designer, modelMatch }) }];

  for (const url of imageUrls.slice(0, 4)) {
    try {
      const { base64, mimeType } = await fetchImageAsBase64(url);
      parts.push({ inline_data: { mime_type: mimeType, data: base64 } });
    } catch (err) {
      log(`Skipping unreachable image: ${err.message}`);
    }
  }

  if (parts.length === 1) {
    throw new Error("No product images could be downloaded for analysis.");
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.6,
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
        const err = new Error(`Gemini request failed (${res.status}): ${JSON.stringify(json)}`);
        err.status = res.status;
        throw err;
      }
      return json;
    },
    { label: "Gemini combined generation" }
  );

  const text =
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;

  if (!text) {
    throw new Error("Gemini returned no content (possibly blocked by safety filters).");
  }

  let result;
  try {
    result = JSON.parse(text);
  } catch (err) {
    throw new Error(`Could not parse Gemini JSON output: ${err.message}`);
  }

  return postProcessResult(result, { promptConfig, product, designer, modelMatch });
}

module.exports = { generateProductContent };
