"use strict";

/**
 * Content & SEO engine.
 *
 * Stage 2 of the pipeline: takes the structured attributes from analyzer.js
 * plus product context, and asks Gemini (text-only) to write the final
 * brand-vlog-style HTML description, meta description, tags and image alt
 * text — following the exact structure the store owner specified.
 *
 * Designer names, collection links and Instagram links are NEVER invented
 * by the model — they are resolved in code from designers.json / models.json
 * and only ever inserted if a real match is found.
 */

const { retryWithBackoff, cleanText, truncate } = require("./util");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Find a designer/model match by scanning title + tags + vendor against each entry's `match` list. */
function findMatch(list, haystackText) {
  const lower = haystackText.toLowerCase();
  for (const entry of list) {
    const patterns = entry.match || [entry.name];
    if (patterns.some((p) => p && lower.includes(String(p).toLowerCase()))) {
      return entry;
    }
  }
  return null;
}

function stripHtml(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function buildTextPrompt({ product, attributes, promptConfig, designer, modelMatch }) {
  const bannedList = (promptConfig.banned_phrases || []).join(", ");

  return `You are an experienced fashion e-commerce copywriter, writing product page content the way a skilled human brand writer would — NOT like a generic AI product blurb.

PRODUCT CONTEXT:
- Title: ${product.title}
- Vendor: ${product.vendor || "(unknown)"}
- Existing description (for reference only, may mention fabric — reuse fabric names from here if present, do not invent new ones): ${stripHtml(product.descriptionHtml).slice(0, 600) || "(none)"}

VISUALLY CONFIRMED ATTRIBUTES (only use what's here — do not add anything beyond this):
${JSON.stringify(attributes, null, 2)}

${designer ? `DESIGNER (confirmed): ${designer.name}, collection link: ${designer.collection_url}` : "DESIGNER: none confirmed — do not name any designer."}
${modelMatch ? `MODEL/CELEBRITY (confirmed, may mention by name once): ${modelMatch.name}` : "MODEL/CELEBRITY: none confirmed — do NOT name or describe any person in the photo."}

BRAND: ${promptConfig.brand_name} (${promptConfig.brand_url})

WRITE IN: ${promptConfig.language || "English"}

STRUCTURE (follow exactly, output as clean semantic HTML — the theme already renders the product title as H1, so start your headings at H2/H3):
1. A short hook (1-2 sentences) as an opening <p>, evocative but not clichéd.
2. Two short paragraphs (<p>) telling the story of the design/craft and how to style it — grounded ONLY in the confirmed attributes above.
3. An <h2> heading formatted as "${designer ? designer.name : "[Designer]"} — Collection" — but ONLY include this heading at all if a designer was confirmed above. If none was confirmed, skip this heading entirely.
4. Three bullet lists (<ul><li>) with sub-headings (<h3>): "Design Highlights", "Stitching & Finish", "Styling & Occasion" — only include points that are actually supported by the confirmed attributes. Skip a whole section if you have nothing genuine to put in it.
5. A short closing line mentioning the brand name "${promptConfig.brand_name}".

HARD RULES:
- ${promptConfig.extra_rules}
- Never use these overused phrases or close variants of them: ${bannedList}.
- Vary sentence length. Do not make every product sound the same — reflect what's actually different about THIS product.
- No exclamation-mark-heavy marketing voice. Write like a real person who works at the brand.
- Do not fabricate size charts, fabric composition percentages, or care instructions.

Also produce:
- "meta_description": ${promptConfig.meta_description_min_chars}-${promptConfig.meta_description_max_chars} characters, compelling, includes the product type.
- "tags": an array of 6-10 relevant SEO tags (lowercase, no # symbol), based only on confirmed attributes + product type + designer name if confirmed.
- "image_alt_text": a single reusable alt text template (max 125 characters) describing the product generically for its images, e.g. "Embroidered festive kurti with round neckline by ${designer ? designer.name : promptConfig.brand_name}".

IMPORTANT: Do NOT generate or suggest a product title. The product's existing title is never changed by this system.

Respond ONLY with a JSON object, no markdown fences, in this exact shape:
{
  "description_html": "<p>...</p>...",
  "meta_description": "...",
  "tags": ["...", "..."],
  "image_alt_text": "..."
}`;
}

async function generateDescription({ apiKey, model, product, attributes, promptConfig, designers, models }) {
  const haystack = [product.title, product.vendor, ...(product.tags || [])].join(" ");
  const designer = findMatch(designers, haystack);
  const modelMatch = findMatch(models, haystack);

  const prompt = buildTextPrompt({ product, attributes, promptConfig, designer, modelMatch });

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.75,
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
        const err = new Error(`Gemini text request failed (${res.status}): ${JSON.stringify(json)}`);
        err.status = res.status;
        throw err;
      }
      return json;
    },
    { label: "Gemini description generation" }
  );

  const text =
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;

  if (!text) {
    throw new Error("Gemini returned no description content (possibly blocked by safety filters).");
  }

  let result;
  try {
    result = JSON.parse(text);
  } catch (err) {
    throw new Error(`Could not parse Gemini description JSON output: ${err.message}`);
  }

  // Post-process / enforce hard limits in code (never trust the model blindly on lengths).
  result.description_html = cleanText(result.description_html);
  result.meta_description = truncate(cleanText(result.meta_description), promptConfig.meta_description_max_chars || 160);
  result.tags = Array.isArray(result.tags) ? result.tags.slice(0, 10) : [];
  result.image_alt_text = truncate(cleanText(result.image_alt_text), 125);

  // Append the brand link + (if confirmed) the designer collection link / model Instagram link.
  // These links are inserted here in code — never generated by the model — so they are always correct.
  let html = result.description_html;

  if (designer && designer.collection_url && html.includes(designer.name)) {
    // Link the designer heading text if present.
    const headingRegex = new RegExp(`(<h2[^>]*>)(\\s*${designer.name}[^<]*)(</h2>)`, "i");
    if (headingRegex.test(html)) {
      html = html.replace(headingRegex, `$1<a href="${designer.collection_url}">$2</a>$3`);
    }
  }

  if (modelMatch && modelMatch.instagram && html.includes(modelMatch.name)) {
    html = html.replace(
      modelMatch.name,
      `<a href="${modelMatch.instagram}" rel="nofollow">${modelMatch.name}</a>`
    );
  }

  html += `\n<p><a href="${promptConfig.brand_url}">${promptConfig.brand_name}</a></p>`;

  result.description_html = html;
  result.designer_matched = designer ? designer.name : null;
  result.model_matched = modelMatch ? modelMatch.name : null;

  return result;
}

module.exports = { generateDescription, findMatch };
