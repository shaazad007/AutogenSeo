"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");
const candidatePrompt = require("../lib/promptShared");
const { resolveBrandCollection } = require("../lib/brandCollection");

const root = path.resolve(__dirname, "..");
const fixtures = require("./fixtures/pr2-preview-products.json");
const promptConfig = {
  detect: "visible colours, print, embroidery, dupatta and garment components",
  extra_rules: "Use confirmed evidence only; never guess fabric.",
  language: "English",
  brand_name: "Sara Clothes",
  brand_url: "https://saraclothes.com",
  banned_phrases: [],
  meta_description_min_chars: 150,
  meta_description_max_chars: 160,
  brand_collection_handles: ["imrozia", "mushq"],
};

function loadBasePrompt() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-base-main-prompt-"));
  const dependencies = ["promptShared.js", "designProfile.js", "util.js", "metaTemplates.js", "styleTemplates.js"];
  for (const name of dependencies) {
    const content = execFileSync("git", ["show", `origin/main:lib/${name}`], { cwd: root, encoding: "utf8" });
    fs.writeFileSync(path.join(temp, name), content);
  }
  return require(path.join(temp, "promptShared.js"));
}

test("PR2 read-only five-fixture comparison: identical inputs, base vs candidate", () => {
  const basePrompt = loadBasePrompt();
  let baseRequests = 0;
  let candidateRequests = 0;
  const summaries = [];
  assert.equal(fixtures.length, 5);

  for (const fixture of fixtures) {
    const product = {
      id: fixture.id,
      title: fixture.title,
      vendor: fixture.vendor,
      originalDescriptionHtml: fixture.original_description,
      descriptionHtml: fixture.original_description,
      collections: { nodes: fixture.collections },
      brandCollectionTitle: resolveBrandCollection(
        { collections: { nodes: fixture.collections } }, promptConfig,
      ),
      options: [],
    };
    const baseInput = structuredClone(product);
    const candidateInput = structuredClone(product);
    assert.deepEqual(candidateInput, baseInput, `${fixture.id}: frozen inputs must match`);

    // Deterministic mocked multimodal response: one combined response per fixture/version.
    baseRequests += 1;
    const baseResult = basePrompt.postProcessResult(structuredClone(fixture.response), {
      promptConfig,
      product: baseInput,
      designer: null,
      modelMatch: null,
      includeDesignProfile: true,
    });
    candidateRequests += 1;
    const candidateResult = candidatePrompt.postProcessResult(structuredClone(fixture.response), {
      promptConfig,
      product: candidateInput,
      designer: null,
      modelMatch: null,
      includeDesignProfile: true,
    });
    const collectionTitle = resolveBrandCollection(candidateInput, promptConfig);
    const vendor = String(candidateInput.vendor || "").trim();
    candidateResult.design_profile.brand = collectionTitle
      ? { value: collectionTitle, source: "collection", confidence: 1 }
      : vendor
        ? { value: vendor, source: "shopify_vendor", confidence: 1 }
        : { value: null, source: "unknown", confidence: 0 };

    assert.doesNotMatch(candidateResult.description_html, /Sara Clothes|saraclothes\.com/i);
    assert.equal(candidateResult.design_profile.schema_version, 1);
    assert.deepEqual(candidateResult.design_profile.fabric, baseResult.design_profile.fabric);
    if (fixture.response.design_profile.fabric) {
      for (const fact of Object.values(candidateResult.design_profile.fabric)) {
        if (fact.value) assert.ok(["old_description", "title", "shopify_description", "shopify_title", "shopify_variant"].includes(fact.source));
      }
    }
    if (collectionTitle) {
      assert.equal(candidateResult.design_profile.brand.value, collectionTitle);
      assert.equal(candidateResult.design_profile.brand.source, "collection");
    } else {
      assert.equal(candidateResult.design_profile.brand.value, fixture.vendor);
      assert.equal(candidateResult.design_profile.brand.source, "shopify_vendor");
    }
    summaries.push({
      id: fixture.id,
      base_description: baseResult.description_html,
      candidate_description: candidateResult.description_html,
      base_brand: baseResult.design_profile.brand,
      candidate_brand: candidateResult.design_profile.brand,
      candidate_fabric: candidateResult.design_profile.fabric,
      requests_per_version: 1,
    });
  }
  assert.equal(baseRequests, 5);
  assert.equal(candidateRequests, 5);
  console.log(`PR2 fixture comparison (synthetic, read-only): ${JSON.stringify(summaries)}`);
});
