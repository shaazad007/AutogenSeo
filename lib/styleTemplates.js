"use strict";

/**
 * 20 distinct structural/voice directives for description_html.
 *
 * WHY THIS EXISTS: a single fixed structure (hook -> 2 paragraphs -> H2 ->
 * 3 bullet sections) applied to every one of 80,000 products reads as
 * obviously machine-generated once a shopper sees a few pages — same
 * shape, same rhythm, every time. Real fashion editorial writing (the
 * kind found in fashion magazines) varies: sometimes flowing prose with
 * no headers at all, sometimes a craft-first opening, sometimes a single
 * short bullet list instead of three, sometimes a direct/conversational
 * voice instead of a narrated one.
 *
 * Each directive below only changes STRUCTURE and VOICE — never the hard
 * rules (no fabric-guessing, no invented people, brand/product identity
 * stays exactly as given). One is chosen at random per product in
 * promptShared.js, so a page of products reads like it was written by a
 * small team of writers, not one template running on autopilot.
 */
const STYLE_DIRECTIVES = [
  // 1 — Narrative opening, flowing prose, no headers or bullets at all
  `Open with a short scene-setting line (a moment, a mood, a setting) rather than a marketing hook. Follow with two flowing narrative paragraphs on the design and how it wears — no headers, no bullet lists at all. Close by weaving the brand name naturally into the final sentence, not as a separate line.`,

  // 2 — Craft/heritage-focus
  `Open by naming the specific visible technique or craft (e.g. the embroidery, the print, the weave pattern) as the headline focus of the first sentence. One paragraph narrating it. Then a single <h3>The Craft</h3> with 3-4 bullets on construction details only. Close with a short line mentioning the brand.`,

  // 3 — Styling-guide voice
  `Open with a practical styling framing ("Here's how to wear it" in spirit, not those exact words). One paragraph on the overall look. Then <h3>Style It With</h3> — bullets on occasion/pairing ideas grounded in what's visible. Then <h3>The Details</h3> — bullets on construction.`,

  // 4 — Colour-story lead
  `Open by describing the colour and mood first, before anything else. One descriptive paragraph. Then, only if a designer is confirmed, an <h2> collection heading. Then two <h3> bullet sections covering design and finish.`,

  // 5 — Question opening
  `Open with one short, natural question about the occasion or mood this piece suits (not a generic "looking for the perfect X?" cliché — make it specific to what's visible). Answer it in a paragraph. Add a second flowing paragraph. End with a single <h3>Why You'll Love It</h3> bullet list.`,

  // 6 — Minimalist short-form
  `Keep it short: one tight, confident paragraph (3-4 sentences). No headers. A single flat bullet list under <h3>At a Glance</h3> with 3-4 points. One closing line mentioning the brand.`,

  // 7 — Texture-first (only if a fabric/texture is already named in the title or existing description)
  `If a fabric or texture is already named in the existing title/description, open on how it feels/drapes. Otherwise open on visible surface texture only (e.g. matte, sheen, embroidered texture) without naming any fabric. Two paragraphs. One <h3>Design Notes</h3> bullet section.`,

  // 8 — Silhouette-first
  `Open by describing the cut and silhouette before anything else — the shape a shopper would notice first. One narrative paragraph. Then <h3>Fit & Silhouette</h3> bullets, then <h3>Finishing Touches</h3> bullets.`,

  // 9 — Occasion-narrative
  `Open by picturing a specific, plausible occasion or setting this piece suits, grounded in its visible style (festive, casual, formal — inferred only from what's shown, not invented). One paragraph developing that scene. Then <h3>Perfect For</h3> bullets.`,

  // 10 — Direct, no-bullets editorial
  `Two paragraphs only, no headers, no bullet points anywhere. First paragraph short and confident, second paragraph longer and more descriptive. Close with one line mentioning the brand.`,

  // 11 — Contrast pacing, single highlights section
  `First paragraph: short and punchy (2 sentences max). Second paragraph: longer and more descriptive. If a designer is confirmed, add an <h2> collection heading. Then just ONE <h3>Highlights</h3> bullet section (not three) — combine the best 4-5 points into it.`,

  // 12 — Single combined list
  `One flowing paragraph only. Then a single <h3>What Makes It Special</h3> bullet list that mixes design, stitching, and styling points together naturally, rather than splitting them into separate sections.`,

  // 13 — Showcase-report voice
  `Open as if briefly reporting what stands out about this design's visual language — direct, observational, not gushing. One paragraph. Then the usual three sections (<h3>Design Highlights</h3>, <h3>Stitching & Finish</h3>, <h3>Styling & Occasion</h3>) but phrase each bullet in a slightly more editorial, less spec-sheet tone.`,

  // 14 — Personal styling-note voice
  `Open as a short, personal styling note — as if a stylist were pointing out what they notice first. Two paragraphs. Then a single <h3>Styling Notes</h3> bullet section only.`,

  // 15 — Craft spotlight, two sections
  `Open by spotlighting one specific visible technique by name as the first sentence's subject. One paragraph. Then <h3>The Craft</h3> bullets and <h3>Styling & Occasion</h3> bullets.`,

  // 16 — Understated/restrained
  `Write with restraint — plain, confident sentences, minimal adjectives. Two short paragraphs. A single <h3>Details</h3> bullet list with 3-4 points. No exclamation, no superlatives.`,

  // 17 — Reordered full structure
  `Use the fuller structure but in a different order than usual: one paragraph, then (if a designer is confirmed) the <h2> collection heading, then <h3>Styling & Occasion</h3> bullets FIRST, then <h3>Stitching & Finish</h3>, then <h3>Design Highlights</h3> last.`,

  // 18 — Conversational, second-person
  `Write directly to the reader in a natural conversational tone (you'll notice, you can pair). One paragraph. Then <h3>Why It Works</h3> bullets.`,

  // 19 — Vignette + full structure
  `Open with a two-sentence vignette (a brief scene or moment) rather than a generic hook. Follow the fuller structure: two paragraphs, an <h2> collection heading if a designer is confirmed, and all three <h3> sections (Design Highlights, Stitching & Finish, Styling & Occasion).`,

  // 20 — Catalog-minimal but human
  `Keep it brief and clear: one short paragraph, then a single <h3>Details</h3> list with exactly 3 bullets. One closing line naming the brand. No designer heading even if one is confirmed — keep this variant deliberately compact.`,
];

function pickRandomStyleDirective() {
  return STYLE_DIRECTIVES[Math.floor(Math.random() * STYLE_DIRECTIVES.length)];
}

module.exports = { STYLE_DIRECTIVES, pickRandomStyleDirective };
