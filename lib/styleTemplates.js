"use strict";

const crypto = require("node:crypto");

const LAYOUT_FAMILIES = [
  { id: "design-first", headings: ["Design & Embroidery", "Product Details", "Styling Notes"] },
  { id: "craft-first", headings: ["Craft Details", "Fabric & Components", "Finishing Details"] },
  { id: "colour-first", headings: ["Colour, Print & Craft", "Product Details"] },
  { id: "silhouette-first", headings: ["Silhouette & Details", "Dupatta & Trouser"] },
  { id: "compact-catalog", headings: ["Key Details", "Design Notes"] },
];

function selectLayoutFamily(product = {}) {
  const stableKey = String(product.id || product.handle || product.title || "product");
  const digest = crypto.createHash("sha256").update(stableKey).digest();
  return LAYOUT_FAMILIES[digest.readUInt32BE(0) % LAYOUT_FAMILIES.length];
}

function getLayoutDirective(product = {}) {
  const layout = selectLayoutFamily(product);
  return `Use the ${layout.id} layout family, selected deterministically for this product. Use only these optional H2 sections when their content exists: ${layout.headings.join("; ")}.`;
}

function renderDescriptionContent(content = {}, product = {}) {
  const layout = selectLayoutFamily(product);
  const sections = [];
  const intro = safeText(content.intro);
  const design = safeText(content.design_summary);
  const visual = safeText(content.visual_details);
  const fabric = safeText(content.fabric_components);
  const styling = safeText(content.styling_note);
  const featureBullets = safeList(content.feature_bullets);
  const componentBullets = safeList(content.component_bullets);
  const paragraph = (value) => value ? `<p>${escapeHtml(value)}</p>` : "";
  const heading = (name, body) => body ? `<h2>${escapeHtml(name)}</h2>${body}` : "";
  const list = (items) => items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";

  if (intro) sections.push(paragraph(intro));
  switch (layout.id) {
    case "design-first":
      sections.push(heading("Design & Embroidery", paragraph(design || visual)));
      sections.push(heading("Product Details", list([...featureBullets, ...componentBullets])));
      sections.push(heading("Styling Notes", paragraph(styling)));
      break;
    case "craft-first":
      sections.push(heading("Craft Details", paragraph(design || visual)));
      sections.push(heading("Fabric & Components", paragraph(fabric) + list(componentBullets)));
      sections.push(heading("Finishing Details", list(featureBullets)));
      sections.push(heading("Styling Notes", paragraph(styling)));
      break;
    case "colour-first":
      sections.push(heading("Colour, Print & Craft", paragraph(visual || design)));
      sections.push(heading("Product Details", paragraph(fabric) + list([...featureBullets, ...componentBullets])));
      sections.push(heading("Styling Notes", paragraph(styling)));
      break;
    case "silhouette-first":
      sections.push(heading("Silhouette & Details", paragraph(design || visual) + list(featureBullets)));
      sections.push(heading("Dupatta & Trouser", paragraph(fabric) + list(componentBullets)));
      sections.push(heading("Styling Notes", paragraph(styling)));
      break;
    default:
      sections.push(heading("Key Details", paragraph(design || visual) + paragraph(fabric) + list([...featureBullets, ...componentBullets])));
      sections.push(heading("Design Notes", paragraph(styling)));
  }

  return sections.filter(Boolean).join("\n");
}

function safeText(value) {
  return typeof value === "string"
    ? value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

function safeList(value) {
  return Array.isArray(value) ? value.map(safeText).filter(Boolean).slice(0, 12) : [];
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

module.exports = { LAYOUT_FAMILIES, selectLayoutFamily, getLayoutDirective, renderDescriptionContent };
