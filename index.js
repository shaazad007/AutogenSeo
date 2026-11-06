"use strict";

/**
 * Entry point.
 *
 * Usage:
 *   node index.js --mode=preview --limit=10   (safe: writes to /preview only, touches nothing on Shopify)
 *   node index.js --mode=preview --collection-handle=new-arrivals --limit=10
 *   node index.js --mode=collections         (read-only collection inventory refresh)
 *   node index.js --mode=live                 (writes to Shopify, up to config.json's daily_cap per day)
 *   node index.js --mode=live --limit=50       (override the per-run limit, e.g. for a smaller manual test)
 *
 * This is what .github/workflows/auto-process.yml runs every night.
 */

const fs = require("fs");

const config = require("./lib/config");
const { ShopifyClient } = require("./lib/shopify");
const { runBatch } = require("./lib/processor");
const { log } = require("./lib/util");

function parseArgs() {
  const args = { mode: "preview", limit: 10, collectionHandle: "" };
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "mode") args.mode = value;
    if (key === "limit") args.limit = parseInt(value, 10);
    if (key === "collection-handle") args.collectionHandle = value || "";
  }
  return args;
}

async function main() {
  const { mode, limit, collectionHandle } = parseArgs();

  if (!["preview", "live", "collections"].includes(mode)) {
    throw new Error(`Unknown --mode "${mode}". Use "preview", "live", or "collections".`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000) {
    throw new Error("--limit must be an integer from 1 to 100000.");
  }
  if (collectionHandle && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(collectionHandle)) {
    throw new Error("--collection-handle must be a lowercase Shopify handle.");
  }

  // Stay safely under GitHub Actions' hard 6-hour (360-minute) job limit.
  // Configurable via config.json's job_time_budget_minutes; defaults to 320
  // (5h20m), leaving buffer for setup/commit steps either side.
  const budgetMinutes = config.promptConfig.job_time_budget_minutes || 320;
  const deadlineMs = Date.now() + budgetMinutes * 60 * 1000;

  log(`Starting run — mode=${mode}, limit=${limit}, time budget=${budgetMinutes}m`);

  const shopify = new ShopifyClient({
    store: config.env.SHOPIFY_STORE,
    clientId: config.env.SHOPIFY_CLIENT_ID,
    clientSecret: config.env.SHOPIFY_CLIENT_SECRET,
  });

  if (mode === "collections") {
    const previous = JSON.parse(fs.readFileSync(config.paths.progress, "utf8"));
    const previousCollections = previous.collections || {};
    const isResume = previous.collections_refresh_status === "in_progress";
    const skipHandles = new Set(isResume
      ? Object.entries(previousCollections)
        .filter(([, item]) => item && item.last_checked_at)
        .map(([handle]) => handle)
      : []);
    const refreshStartedAt = isResume && previous.collections_refresh_started_at
      ? previous.collections_refresh_started_at
      : new Date().toISOString();
    let collectionCount = 0;
    let completedCount = skipHandles.size;
    const [total, remaining, stats] = await Promise.all([
      shopify.countTotalProducts(),
      shopify.countUnprocessedProducts(),
      shopify.getAllCollectionStats({
        skipHandles,
        onStart: async (listedCollections) => {
          collectionCount = listedCollections.length;
          const listedHandles = new Set(listedCollections.map((item) => item.handle));
          for (const handle of skipHandles) {
            if (!listedHandles.has(handle)) skipHandles.delete(handle);
          }
          for (const handle of Object.keys(previousCollections)) {
            if (!listedHandles.has(handle)) delete previousCollections[handle];
          }
          completedCount = skipHandles.size;
          previous.collections = previousCollections;
          previous.collections_refresh_status = "in_progress";
          previous.collections_refresh_started_at = refreshStartedAt;
          previous.collections_refresh_completed_count = skipHandles.size;
          previous.collections_refresh_total_count = collectionCount;
          fs.writeFileSync(config.paths.progress, JSON.stringify(previous, null, 2));
        },
        onCollection: async (item, completedIndex, totalCount) => {
          const oldTotal = previousCollections[item.handle]?.total;
          previousCollections[item.handle] = {
            ...item,
            remaining: Math.max(0, item.total - item.done),
            new_since_last_check: Number.isInteger(oldTotal) ? Math.max(0, item.total - oldTotal) : 0,
            status: item.done >= item.total ? "complete" : item.done > 0 ? "in_progress" : "pending",
            last_checked_at: new Date().toISOString(),
          };
          previous.collections = previousCollections;
          completedCount += 1;
          previous.collections_refresh_completed_count = completedCount;
          previous.collections_refresh_total_count = totalCount;
          fs.writeFileSync(config.paths.progress, JSON.stringify(previous, null, 2));
        },
      }),
    ]);
    const refreshedAt = new Date().toISOString();
    previous.total_products = total;
    previous.total_done = total - remaining;
    previous.collections = previousCollections;
    previous.collections_last_refreshed_at = refreshedAt;
    previous.collections_refresh_status = "complete";
    previous.collections_refresh_completed_count = collectionCount;
    previous.collections_refresh_total_count = collectionCount;
    fs.writeFileSync(config.paths.progress, JSON.stringify(previous, null, 2));
    fs.writeFileSync(config.paths.runLog, JSON.stringify({
      mode, finished_at: refreshedAt, processed: 0, failed: 0,
      stopReason: null, collection_count: collectionCount,
      lines: [`Refreshed ${collectionCount} Shopify collections; no products were changed.`],
    }, null, 2));
    log(`Refreshed ${collectionCount} Shopify collections. No products were changed.`);
    return;
  }

  if (collectionHandle) config.promptConfig.collection_filter = [collectionHandle];

  const runLog = [];
  const { processed, failed, stopReason, usedGroqCount } = await runBatch({ shopify, config, mode, limit, runLog, deadlineMs });

  const reasonNote =
    stopReason === "time_budget"
      ? " (stopped early: time budget reached — will resume next scheduled run)"
      : stopReason === "daily_quota"
      ? " (stopped early: Gemini daily quota exhausted — will resume next scheduled run)"
      : "";
  const groqNote = usedGroqCount ? ` (${usedGroqCount} of those via Groq fallback)` : "";
  log(`Run finished. Processed: ${processed}, Failed: ${failed}.${reasonNote}${groqNote}`);

  // Write a small log file the dashboard (docs/index.html) can fetch and display.
  const logPayload = {
    mode,
    finished_at: new Date().toISOString(),
    processed,
    failed,
    stopReason: stopReason || null,
    lines: runLog.slice(-200), // keep the dashboard payload small
  };
  fs.writeFileSync(config.paths.runLog, JSON.stringify(logPayload, null, 2));

  if (mode === "preview") {
    log(`Preview files written to /preview — nothing on Shopify was changed. Review them, then run with --mode=live.`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
