# AI Design Profile

## Scope and version

The engine can include a version 1 fashion Design Profile in the same multimodal
generation request used for the existing SEO output. The Shopify target is the
product JSON metafield `custom.ai_design`. Product and variant titles, handles,
SEO fields, tags, image alt text, collection filters, and `ai-done` selection
continue to use the existing processing path.

The profile contains brand; primary, secondary, and contrast colours; shirt,
dupatta, and trouser fabric; neckline; embroidery; shirt; sleeves; daman;
dupatta; trouser; design style; occasion; and normalized matching keywords.
Attribute facts use `{value, source, confidence}`. Unsupported facts are null
with source `unknown`. Neckline and daman shapes and design style use controlled
values. Code supplies schema version, aggregate confidence, evidence source,
image-byte SHA-256, and product-context SHA-256 metadata.

Fabric is never inferred from an image. Fabric facts must cite Shopify title,
description, or variant metadata. Brand facts may cite only title or vendor.
Shopify Color/Colour option values are included in the product context before
the model estimates visible colours. Manual metafields outside `custom.ai_design`
are not changed.

## Preview and live behavior

Preview asks for the profile in the existing image-plus-copy request and writes
it into the generated `preview/*.txt` file. Preview makes no Shopify mutations.
Gemini, Groq, and Cloudflare use the same response contract. A missing or
invalid profile is reported in the preview/log while valid SEO output continues.
No second paid image-analysis request is added.

Already `ai-done` products are excluded from normal runs. An explicit manual
`profile-backfill` run selects only `ai-done` products missing
`custom.ai_design`, generates and writes the profile, and leaves SEO fields,
images, tags, and the normal daily SEO count untouched. The manual workflow
limit and existing collection filter still apply. Scheduled runs never use
backfill mode.

Live profile generation and writes require
`AI_DESIGN_PROFILE_ENABLED=true`. The default is false. The current GitHub
Actions schedule leaves this flag unset, so scheduled live runs remain on the
legacy SEO-only path. The manual `profile-backfill` dispatch opts in for that
single run; it does not enable profile writes for scheduled runs. No live store
was used for these tests.

When enabled, the engine reads the `custom.ai_design` product metafield
definition. It reuses a compatible PRODUCT/JSON definition, creates the
definition only when absent, and refuses to overwrite an incompatible one. It
sets the JSON value and verifies it with a Shopify readback. Existing matching
values are left unchanged. Writes use Shopify `compareDigest` so a concurrent
change between read and set is rejected and can be retried safely.

## Retry and existing products

Before SEO mutations, a validated profile is durably recorded in the existing
`docs/progress.json` as a pending profile write. If Shopify rejects or cannot
verify the metafield write, SEO processing continues and the profile remains in
that retry list. A later opted-in live run retries only the stored profile; it
does not call an AI provider again. The retry record contains product ID, title,
profile JSON, attempt count, timestamps, and last error; it never stores API
credentials or Shopify access tokens.

The existing `ai-done` filter stays in place. Products already tagged
`ai-done` are not automatically reanalyzed or backfilled. A profile-only
backfill for those products needs a separate controlled strategy and is not
part of this change.

## Rollback and controls

- Keep `AI_DESIGN_PROFILE_ENABLED` unset/false to leave production behavior
  disabled.
- If later enabled, turn the flag off to stop new profile generation and
  writes. Existing metafields and pending retry data are preserved.
- Reverting the engine change restores the prior SEO-only generator. It does
  not delete profile metafields already written to Shopify.
- Do not run live tests with production Shopify credentials. Use mocked
  provider and Shopify responses for automated checks.

## Focused checks

```sh
node --test test/designProfile.test.js test/designProfileProviders.test.js test/designProfileShopify.test.js test/processorDesignProfile.test.js
```
