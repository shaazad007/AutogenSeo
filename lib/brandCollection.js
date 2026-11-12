"use strict";

function configuredHandles(promptConfig = {}) {
  return new Set((promptConfig.brand_collection_handles || [])
    .map((handle) => String(handle).trim().toLowerCase())
    .filter(Boolean));
}

function resolveBrandCollection(product = {}, promptConfig = {}, queueCollection = null) {
  const allowed = configuredHandles(promptConfig);
  if (queueCollection && allowed.has(String(queueCollection.handle || "").toLowerCase())) {
    return String(queueCollection.title || "").trim() || null;
  }
  const memberships = product.collections && Array.isArray(product.collections.nodes)
    ? product.collections.nodes
    : [];
  const valid = memberships
    .filter((item) => item && allowed.has(String(item.handle || "").toLowerCase()) && item.title)
    .slice()
    .sort((a, b) => String(a.handle).toLowerCase().localeCompare(String(b.handle).toLowerCase()));
  return valid.length ? String(valid[0].title).trim() : null;
}

module.exports = { resolveBrandCollection };
