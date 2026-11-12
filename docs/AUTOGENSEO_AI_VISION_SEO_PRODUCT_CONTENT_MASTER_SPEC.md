# AUTOGENSEO — AI VISION + SEO PRODUCT CONTENT MASTER SPEC

**Project:** AutogenSeo
**Feature:** AI Vision + Design Profile + SEO Product Content Engine
**Status:** Project feature / implementation specification
**Integration:** Must be registered in the authoritative AutogenSeo master dashboard / roadmap and linked from relevant project documentation.
**Live safety:** `AI_DESIGN_PROFILE_LIVE_ENABLED` must remain **OFF** until real-model read-only validation is approved.

---

## 1. Purpose

Build one durable product-content pipeline that uses the existing multimodal AI analysis once per product and turns the result into:

1. a grounded Shopify product description,
2. a structured Design Profile stored in `custom.custom_ai_design`,
3. SEO metadata,
4. product tags,
5. image alt text,
6. reusable structured facts for ProX / WhatsApp similarity matching,
7. cleaner inputs for Google Search, AI Overview, shopping/product surfaces, and Merchant Center.

The system must improve product-content quality without creating a second paid Vision pass.

---

## 2. Existing Baseline That Must Be Preserved

The following merged behavior is considered baseline and must not be regressed:

- PR #7: original-description backup/provenance safety.
- Original product description is preserved in `ai_backup.original_description_html`.
- Original backup is write-once and must never be overwritten by later AI-generated copy.
- When the backup is unavailable, current Shopify description can be used as a safe fallback.
- PR #8: combined description + Design Profile path.
- `AI_DESIGN_PROFILE_LIVE_ENABLED` exists and defaults to OFF.
- Design Profile schema remains backward compatible.
- Fabric sourced from image is rejected.
- Verified brand collection / vendor fallback logic exists.
- Automatic Sara Clothes footer in product description has been removed.
- No second AI request should be introduced.

---

## 3. Core Architectural Rule — One Multimodal AI Request

For a normal product-processing pass:

**One successful multimodal AI request per product** must produce all AI-derived content needed for the product.

The request may inspect up to the currently supported product images and should return a structured response containing:

- canonical Design Profile facts,
- structured editorial content,
- `key_visual_detail`,
- SEO tags,
- image alt text.

Do **not** add a second Vision request to generate Design Profile, description, SEO, or product matching attributes.

Provider fallback/retry behavior may cause another provider attempt only when the normal provider pipeline requires it. This is not permission to intentionally split the work into separate Vision calls.

---

## 4. Canonical Fact Model

The normalized Design Profile is the canonical structured fact set.

Customer-facing copy must not contradict:

- normalized Design Profile,
- verified original description,
- verified title,
- Shopify product/variant facts,
- verified brand collection/vendor data.

### 4.1 Provenance sources

Supported provenance must remain backward compatible and may include:

- `image`
- `collection`
- `old_description`
- `title`
- existing legacy Shopify provenance labels
- `unknown`

A source label must be truthful.

Example:

- `occasion = festive` must **not** use `source: "title"` unless the actual title explicitly supports “festive”.
- If the visual design clearly supports a high-confidence style classification, `source: "image"` may be used.
- Otherwise return `unknown`.

### 4.2 Facts that may come from images

When clearly visible, Vision should actively inspect and populate:

- primary colour,
- secondary / contrast colour,
- neckline shape,
- neckline embroidery/embellishment,
- embroidery style,
- embroidery motifs,
- embroidery density,
- embroidery placement,
- shirt cut / silhouette,
- shirt length when visually supportable,
- sleeve length / shape,
- sleeve border / embroidery,
- daman shape / border / embroidery,
- dupatta colour,
- dupatta visible pattern / print / embroidery / border,
- trouser visible colour/style,
- visible design style.

Do not leave obvious visible facts `unknown` merely because the text description does not mention them.

### 4.3 Facts that must NOT be guessed from images

Do not infer these from appearance alone:

- fabric,
- exact suit-piece count,
- exact measurements,
- included accessories/components,
- care instructions,
- construction specifications not clearly known,
- shipping/payment/stitching policies.

These must come from verified text/product data or remain unknown/omitted.

---

## 5. Design Profile Metafield

Primary structured output:

- **Namespace:** `custom`
- **Key:** `custom_ai_design`
- **Type:** JSON
- **Owner:** Shopify Product

The existing schema/version must remain backward compatible.

Design Profile categories include:

- brand
- colours
- fabric
- neckline
- embroidery
- shirt
- sleeves
- daman
- dupatta
- trouser
- design style
- occasion
- matching keywords
- metadata / schema version / fingerprints / confidence / evidence provenance

Unknown facts must remain unknown rather than being invented.

---

## 6. Brand Resolution

### 6.1 Store brand vs product brand

**Sara Clothes is the store.** It must not be automatically injected into:

- product description,
- meta description,
- headings,
- footer,
- image alt text.

A verified product/designer/collection brand such as Maria B, Gul Ahmed, Imrozia, Akbar Aslam, Mushq, etc. may be mentioned naturally when grounded.

### 6.2 Brand collection rules

Use the existing `brand_collection_handles` allow-list.

- Configured genuine brand collection → use collection title with provenance `collection`.
- Unlisted sale/category collection → never treat as brand.
- Examples that must not automatically become brands:
  - New Arrivals
  - Eid Sale
  - Sale
  - Summer
  - category/feed collections
- If no valid brand collection exists → Shopify vendor fallback.
- If `brand_collection_handles` is empty → vendor fallback is expected.

---

## 7. Stable Voice, Light Variation — No Random Tone

The current random-tone system must be replaced.

### 7.1 Problem

Runtime random style selection creates obvious AI inconsistency:

- fictional scene-setting,
- “music is soft / evening reception” storytelling,
- rhetorical questions,
- personal stylist voice,
- second-person sales copy,
- invented occasions and accessories,
- repeated AI openings such as:
  - “This design…”
  - “This outfit…”
  - “This suit…”
  - “The overall design…”
  - “The shirt features…”

### 7.2 Required voice

Use one stable brand-independent writing voice:

**Professional fashion editorial/catalog tone**

Characteristics:

- grounded,
- specific,
- natural,
- polished,
- commercially useful,
- not robotic,
- not over-written,
- no fictional scenes,
- no invented lifestyle context,
- no unsupported occasion claims,
- no exaggerated superlatives,
- no keyword stuffing.

### 7.3 Deterministic structural variation

Variation should be **structural and lexical**, not a personality change.

Do not use `Math.random()`.

Choose an approved layout deterministically from product ID/handle/hash.

Requirements:

- same product → same layout on rerun,
- different products → may use different approved layout,
- stable semantic hierarchy,
- no empty headings,
- no random voice switching.

Recommended opening approaches:

1. colour-first,
2. craft/embroidery-first,
3. contrast-first,
4. silhouette-first,
5. distinctive-detail-first,
6. composition-first.

Avoid repeated openings such as “This [Brand]…” across the catalog.

---

## 8. Approved Layout Families

Use approximately 5 deterministic layout families.

### Layout A — Design First
- Intro paragraph
- `H2 Design & Embroidery`
- paragraph
- `H2 Product Details`
- factual bullet list
- optional `H2 Styling Notes`

### Layout B — Craft First
- Intro paragraph focused on embroidery/print/craft
- `H2 Craft Details`
- paragraph
- `H2 Fabric & Components`
- factual bullet list
- `H2 Finishing Details`

### Layout C — Colour & Pattern First
- Intro paragraph
- `H2 Colour, Print & Craft`
- paragraph
- `H2 Product Details`
- bullet list

### Layout D — Silhouette First
- Intro paragraph
- `H2 Silhouette & Details`
- paragraph
- `H2 Dupatta & Trouser`
- bullet list

### Layout E — Compact Catalog
- short intro
- `H2 Key Details`
- bullet list
- `H2 Design Notes`
- short paragraph

Only render a section when verified content exists.

---

## 9. Structured AI Output Before HTML

Preferred long-term response shape:

```json
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
  "design_profile": {},
  "key_visual_detail": "",
  "tags": [],
  "image_alt_text": ""
}
```

Then render final customer-facing HTML in code.

If migrating the response shape immediately is too risky for provider compatibility, implement a backward-compatible transition/fallback. Document what remains legacy.

---

## 10. Semantic HTML Rules

The Shopify theme already supplies the product H1.

Therefore:

- never output an H1 inside product description,
- use H2 for major sections,
- use H3 only as a true subsection below an H2,
- use `<p>` for readable paragraphs,
- use `<ul><li>` for factual details,
- never output orphan `<li>` elements,
- use `<strong>` only for meaningful labels/facts.

Example:

```html
<p>...</p>

<h2>Design & Embroidery</h2>
<p>...</p>

<h2>Product Details</h2>
<ul>
  <li><strong>Brand:</strong> Akbar Aslam</li>
  <li><strong>Fabric:</strong> Organza</li>
  <li><strong>Dupatta:</strong> Embroidered organza dupatta</li>
  <li><strong>Trouser:</strong> Russian Grip</li>
</ul>

<h2>Design Notes</h2>
<p>...</p>
```

Do not create headings solely to place keywords.

---

## 11. Paragraph Length and Natural Copy

Typical paragraph target: approximately 40–80 words.

Do not mechanically force a fixed word count.

- Rich evidence → description may naturally reach roughly 150–300 words.
- Sparse evidence → remain shorter.
- Never pad with generic SEO filler.

Do not promise comfort, breathability, summer cooling, drape, softness, luxury, or similar properties unless product data supports them.

---

## 12. Original Supplier Description Usage

The original product description is an evidence source, not final copy.

Reuse verified facts such as:

- fabric,
- product components,
- measurements,
- embroidery placement,
- dupatta details,
- trouser details,
- included / excluded components.

Do not copy supplier text verbatim.

Do not move operational policy text into the fashion description:

- shipping timings,
- returns policy,
- payment instructions,
- WhatsApp instructions,
- generic stitching-order policy.

These belong to separate store/policy UI.

---

## 13. SEO Keywords

Use natural shopper search language only when grounded.

Examples:

- embroidered organza suit,
- embroidered chiffon dupatta,
- unstitched 3-piece lawn suit,
- hand embellished shirt,
- formal embroidered suit.

Rules:

- no keyword stuffing,
- no repeated keyword loops,
- no customer-facing keyword dump,
- separate tags remain allowed,
- supplier description must be rewritten into original useful copy.

---

## 14. Meta Description Strategy

Meta descriptions must be built from verified facts.

Do not automatically insert “Sara Clothes”.

Preferred ingredients:

- product title / verified brand,
- one or two strong grounded differentiators,
- natural readable sentence.

Aim roughly around 140–160 characters when practical, but do not force awkward truncation.

Do not use generic filler such as:

- “dependable quality you can trust”,
- “must-have”,
- “stunning”,
- “shipped”.

Google may rewrite snippets; factual quality is more important than mechanically filling a character quota.

---

## 15. Image Alt Text

Alt text should:

- describe the product image concisely,
- use verified product brand when appropriate,
- use visible product attributes,
- not automatically inject Sara Clothes,
- avoid keyword stuffing,
- stay within existing length limits.

---

## 16. Generation Randomness

Current generation temperature should be reviewed.

Recommended target for the primary provider:

**~0.35**

Goal:

- preserve natural variation,
- reduce fictional creativity,
- reduce tone drift,
- improve repeatability.

Apply equivalent conservative settings to fallback providers where supported.

---

## 17. Google Search / AI Overview / Shopping Readiness

This is a separate technical SEO layer; do not mix it into product-description HTML.

### 17.1 AI Overview / Gemini visibility

There is no special “Gemini HTML”.

Improve eligibility through:

- crawlable/indexable product pages,
- useful unique visible content,
- correct canonical URL,
- sitemap inclusion,
- accurate product facts,
- semantic page structure,
- strong collection/brand pages.

### 17.2 Product cards / shopping surfaces

Audit Google Merchant / Free Listings readiness.

Product data should remain consistent across:

- page content,
- Shopify product data,
- Merchant Center/feed,
- Product structured data.

### 17.3 Product JSON-LD

Do not inject duplicate Product JSON-LD inside product description.

Audit the Shopify theme first for existing:

- `Product`
- `Offer`
- price
- currency
- availability
- brand
- image
- URL
- SKU / GTIN / MPN where available
- variant data
- shipping / return properties where supported

Report gaps separately for an approved technical SEO task.

#### Repository audit note

The engine repository contains no Shopify theme `.liquid` templates, so the
theme's existing Product/Offer JSON-LD, canonical tags, Merchant Center feed,
variant structured data, and storefront crawl/index behavior were not
audited here. Do not add Product JSON-LD to product descriptions. A theme-level
audit requires the separate Shopify theme source and should be reported as a
separate technical SEO task.

---

## 18. Real-Model Preview Acceptance

`AI_DESIGN_PROFILE_LIVE_ENABLED` remains OFF until real-model read-only preview passes.

Use 3–5 real Shopify products, including:

- a product with verified fabric in the original description,
- a product with strong visible colour/embroidery,
- a product using vendor fallback for brand,
- a product using an allowed brand collection when configured.

For each preview report:

- product ID/title,
- provider,
- AI request count,
- generated description,
- Design Profile,
- brand value/source,
- fabric value/source,
- colours,
- neckline,
- embroidery,
- shirt silhouette,
- sleeve details,
- dupatta details,
- occasion/design-style provenance,
- whether Sara Clothes appears,
- whether unsupported claims were removed,
- HTML validity.

No Shopify writes.

---

## 19. Required Regression Tests

At minimum cover:

### AI / profile
- one AI request per successful product,
- no second Vision call,
- image-sourced fabric rejected,
- piece count cannot be image-sourced,
- visible colours can be image-sourced,
- visible neckline/design details can be image-sourced,
- unsupported title provenance rejected,
- valid collection brand provenance,
- vendor fallback,
- backward-compatible schema.

### Content
- no Sara Clothes in description,
- no Sara Clothes in meta description,
- no Sara Clothes in alt text unless explicitly approved later,
- verified product brand remains allowed,
- no unsupported scene-setting,
- no fictional lifestyle claims,
- no repetitive AI opening loop requirement.

### Layout / HTML
- no `Math.random()` layout selection,
- same product gets same layout,
- multiple products can get different approved layouts,
- no H1,
- valid H2/H3 hierarchy,
- no orphan LI,
- valid UL/LI structure,
- deterministic layout selection,
- only verified sections render.

### Safety / rollout
- feature flag OFF preserves normal SEO processing,
- feature flag ON produces profile in same AI request,
- no live Shopify write in preview,
- `git diff --check` passes.

---

## 20. Rollout Safety

1. Implement on a feature branch from latest `main`.
2. Keep `AI_DESIGN_PROFILE_LIVE_ENABLED=false`.
3. Run unit/regression tests.
4. Run synthetic deterministic fixtures.
5. Run real-model read-only preview.
6. Review 3–5 real products.
7. Only after owner approval consider a limited live test.
8. Do not enable globally without explicit approval.
9. Preserve rollback path: set the flag to `false` or remove it.

---

## 21. Dashboard / Master Roadmap Integration

This specification is a permanent AutogenSeo project feature, not a one-off prompt.

The implementing agent must:

1. Locate the authoritative AutogenSeo master dashboard / roadmap / task board files before editing.
2. Register this feature under the appropriate AI SEO / Product Processing / Shopify pipeline phase.
3. Link this specification from the master dashboard/roadmap.
4. Record dependencies:
   - PR #7 merged — original description provenance/backup
   - PR #8 merged — combined Design Profile processing
5. Record safety state:
   - live profile feature flag OFF
   - real-model validation required
6. Record implementation status and next checkpoint.
7. Do not mark the feature complete until real-model preview acceptance is passed.
8. If the project uses task IDs, assign/update the ID according to the authoritative existing task system rather than inventing a conflicting ID.

Suggested dashboard label:

**AI Vision + SEO Product Content Engine**

Suggested state at registration:

**In Progress / Validation Required**

Suggested next checkpoint:

**Deterministic editorial renderer + Vision grounding hardening + real-model preview**

---

## 22. Documentation Linkage

Add a visible reference to this spec from:

- authoritative master roadmap/dashboard,
- relevant AI/SEO processing documentation,
- `AGENTS.md` or agent bootstrap guidance if that file is authoritative for implementation rules.

Do not duplicate the entire specification into multiple files. Link to this canonical MD instead.

---

## 23. Definition of Done

The feature is complete only when:

- one AI multimodal request produces the needed structured content/profile,
- visible image facts are reliably captured,
- fabric/piece count remain text-grounded,
- Design Profile provenance is truthful,
- Sara Clothes is not automatically injected,
- product brand is correctly resolved,
- tone is stable,
- layout variation is deterministic,
- semantic HTML is valid,
- descriptions are unique and useful,
- no random storytelling remains,
- SEO metadata is grounded,
- structured-data audit is documented,
- tests pass,
- real-model preview passes,
- owner approves live flag enablement,
- master dashboard/roadmap reflects final status.

---

## 24. Non-Goals

This task does NOT authorize:

- automatic live flag enablement,
- live Shopify writes during validation,
- Flutter UI work,
- PR3 work unless separately approved,
- duplicate Product JSON-LD injection,
- a second paid Vision pass,
- replacing project governance/task discipline.
