"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { runProviderFallback } = require("../lib/providerFallback");
const { markGroqProviderLimit } = require("../lib/groq");

function limited(daily = true) {
  const error = new Error("quota limited");
  error.dailyQuotaExhausted = daily;
  if (!daily) error.status = 429;
  return error;
}

function provider(name, call, { configured = true, error, value = name } = {}) {
  return {
    name,
    configured,
    async generate() {
      call.push(name);
      if (error) throw error;
      return value;
    },
  };
}

test("Gemini success keeps Groq and Cloudflare untouched", async () => {
  const calls = [];
  const { result, providerName } = await runProviderFallback([
    provider("Gemini", calls, { value: "gemini-result" }),
    provider("Groq", calls),
    provider("Cloudflare Workers AI", calls),
  ]);
  assert.equal(result, "gemini-result");
  assert.equal(providerName, "Gemini");
  assert.deepEqual(calls, ["Gemini"]);
});

test("Groq remains the first fallback when Gemini hits daily quota", async () => {
  const calls = [];
  const { result, providerName } = await runProviderFallback([
    provider("Gemini", calls, { error: limited() }),
    provider("Groq", calls, { value: "groq-result" }),
    provider("Cloudflare Workers AI", calls),
  ]);
  assert.equal(result, "groq-result");
  assert.equal(providerName, "Groq");
  assert.deepEqual(calls, ["Gemini", "Groq"]);
});

test("Cloudflare runs only after Gemini and Groq are quota-limited", async () => {
  const calls = [];
  const { result, providerName } = await runProviderFallback([
    provider("Gemini", calls, { error: limited() }),
    provider("Groq", calls, { error: limited(false) }),
    provider("Cloudflare Workers AI", calls, { value: "cloudflare-result" }),
  ]);
  assert.equal(result, "cloudflare-result");
  assert.equal(providerName, "Cloudflare Workers AI");
  assert.deepEqual(calls, ["Gemini", "Groq", "Cloudflare Workers AI"]);
});

test("Groq 413 rate_limit_exceeded falls through to Cloudflare", async () => {
  const calls = [];
  const groqLimit = markGroqProviderLimit(
    Object.assign(new Error("Groq request failed (413)"), { status: 413 }),
    { error: { code: "rate_limit_exceeded" } },
  );
  const { result, providerName } = await runProviderFallback([
    provider("Gemini", calls, { error: limited() }),
    provider("Groq", calls, { error: groqLimit }),
    provider("Cloudflare Workers AI", calls, { value: "cloudflare-result" }),
  ]);
  assert.equal(groqLimit.providerLimitReached, true);
  assert.equal(groqLimit.providerCode, "rate_limit_exceeded");
  assert.equal(result, "cloudflare-result");
  assert.equal(providerName, "Cloudflare Workers AI");
  assert.deepEqual(calls, ["Gemini", "Groq", "Cloudflare Workers AI"]);
});

test("unconfigured providers are skipped and quota exhaustion stops cleanly", async () => {
  const calls = [];
  await assert.rejects(
    runProviderFallback([
      provider("Gemini", calls, { error: limited() }),
      provider("Groq", calls, { configured: false }),
      provider("Cloudflare Workers AI", calls, { configured: false }),
    ]),
    (error) => error.providerCascadeExhausted === true &&
      error.allDailyQuotas === true,
  );
  assert.deepEqual(calls, ["Gemini"]);
});

test("non-quota provider errors stop the cascade", async () => {
  const calls = [];
  await assert.rejects(
    runProviderFallback([
      provider("Gemini", calls, { error: new Error("invalid configuration") }),
      provider("Groq", calls),
    ]),
    /invalid configuration/,
  );
  assert.deepEqual(calls, ["Gemini"]);
});
