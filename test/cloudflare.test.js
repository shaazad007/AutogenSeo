"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildCloudflareRequestBody,
  DEFAULT_CLOUDFLARE_MODEL,
} = require("../lib/cloudflare");

test("Cloudflare Qwen request limits reasoning and reserves enough completion tokens", () => {
  const body = buildCloudflareRequestBody({
    promptText: "Return product copy as JSON.",
    imageParts: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AA==" } }],
  });

  assert.equal(body.model, DEFAULT_CLOUDFLARE_MODEL);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.max_completion_tokens, 4096);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].content.length, 2);
});
