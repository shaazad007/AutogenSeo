"use strict";

/**
 * Cloudflare Workers AI vision fallback.
 * Uses the OpenAI-compatible chat endpoint and the vision-capable Qwen model.
 */

const { retryWithBackoff, log } = require("./util");
const { fetchImageAsBase64 } = require("./analyzer");
const { findMatch } = require("./description");
const { buildCombinedPromptText, postProcessResult } = require("./promptShared");

const CLOUDFLARE_BASE = "https://api.cloudflare.com/client/v4/accounts";
const DEFAULT_CLOUDFLARE_MODEL = "@cf/qwen/qwen3.8-27b";

async function generateWithCloudflare({
  apiToken,
  accountId,
  model,
  product,
  imageUrls,
  promptConfig,
  designers,
  models,
}) {
  if (!apiToken || !accountId) {
    throw new Error("Cloudflare Workers AI credentials are not configured.");
  }

  const haystack = [product.title, product.vendor, ...(product.tags || [])].join(" ");
  const designer = findMatch(designers, haystack);
  const modelMatch = findMatch(models, haystack);
  const promptText = buildCombinedPromptText({ promptConfig, product, designer, modelMatch });

  const imageParts = [];
  for (const url of imageUrls.slice(0, 3)) {
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

  const endpoint = `${CLOUDFLARE_BASE}/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
  const body = {
    model: model || DEFAULT_CLOUDFLARE_MODEL,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: promptText }, ...imageParts],
      },
    ],
    temperature: 0.6,
    max_tokens: 2048,
    response_format: { type: "json_object" },
    stream: false,
  };

  const data = await retryWithBackoff(
    async () => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(`Cloudflare Workers AI request failed (${res.status}): ${JSON.stringify(json)}`);
        err.status = res.status;
        throw err;
      }
      return json;
    },
    { label: "Cloudflare Workers AI combined generation" }
  );

  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Cloudflare Workers AI returned no content.");
  }

  let result;
  try {
    result = JSON.parse(text);
  } catch (err) {
    throw new Error(`Could not parse Cloudflare Workers AI JSON output: ${err.message}`);
  }

  return postProcessResult(result, { promptConfig, product, designer, modelMatch });
}

module.exports = { generateWithCloudflare, DEFAULT_CLOUDFLARE_MODEL };
