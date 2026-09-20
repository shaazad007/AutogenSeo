"use strict";

/**
 * Groq fallback provider.
 *
 * WHY THIS EXISTS: Gemini's free tier has a real daily request cap (RPD).
 * Once that's used up for the day, instead of stopping the whole run,
 * processor.js automatically switches to Groq (a completely separate
 * company's free tier) for the rest of that run. This is the safe way to
 * get more daily throughput — using two different providers' legitimate
 * free tiers, rather than rotating multiple accounts on ONE provider
 * (which Google's terms explicitly treat as quota-circumvention and can
 * get a project restricted).
 *
 * Groq's API is OpenAI-compatible (chat completions format), and their
 * Llama 4 Scout model supports vision (multiple images per request).
 *
 * This mirrors lib/generate.js's prompt and post-processing exactly, so
 * output quality/structure/guardrails are the same regardless of which
 * provider actually generated it.
 */

const { retryWithBackoff, log } = require("./util");
const { fetchImageAsBase64 } = require("./analyzer");
const { findMatch } = require("./description");
const { buildCombinedPromptText, postProcessResult } = require("./promptShared");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

async function generateWithGroq({ apiKey, model, product, imageUrls, promptConfig, designers, models }) {
  const haystack = [product.title, product.vendor, ...(product.tags || [])].join(" ");
  const designer = findMatch(designers, haystack);
  const modelMatch = findMatch(models, haystack);

  const promptText = buildCombinedPromptText({ promptConfig, product, designer, modelMatch });

  const imageParts = [];
  for (const url of imageUrls.slice(0, 4)) {
    try {
      const { base64, mimeType } = await fetchImageAsBase64(url);
      imageParts.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${base64}` },
      });
    } catch (err) {
      log(`Skipping unreachable image: ${err.message}`);
    }
  }

  if (imageParts.length === 0) {
    throw new Error("No product images could be downloaded for analysis.");
  }

  const body = {
    model: model || DEFAULT_GROQ_MODEL,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: promptText }, ...imageParts],
      },
    ],
    temperature: 0.6,
    response_format: { type: "json_object" },
  };

  const data = await retryWithBackoff(
    async () => {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(`Groq request failed (${res.status}): ${JSON.stringify(json)}`);
        err.status = res.status;
        throw err;
      }
      return json;
    },
    { label: "Groq combined generation" }
  );

  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;

  if (!text) {
    throw new Error("Groq returned no content.");
  }

  let result;
  try {
    result = JSON.parse(text);
  } catch (err) {
    throw new Error(`Could not parse Groq JSON output: ${err.message}`);
  }

  return postProcessResult(result, { promptConfig, product, designer, modelMatch });
}

module.exports = { generateWithGroq, DEFAULT_GROQ_MODEL };
