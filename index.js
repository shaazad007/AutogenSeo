"use strict";

/**
 * Entry point.
 *
 * Usage:
 *   node index.js --mode=preview --limit=10   (safe: writes to /preview only, touches nothing on Shopify)
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
  const args = { mode: "preview", limit: 10 };
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "mode") args.mode = value;
    if (key === "limit") args.limit = parseInt(value, 10);
  }
  return args;
}

async function main() {
  const { mode, limit } = parseArgs();

  if (!["preview", "live"].includes(mode)) {
    throw new Error(`Unknown --mode "${mode}". Use "preview" or "live".`);
  }

  log(`Starting run — mode=${mode}, limit=${limit}`);

  const shopify = new ShopifyClient({
    store: config.env.SHOPIFY_STORE,
    clientId: config.env.SHOPIFY_CLIENT_ID,
    clientSecret: config.env.SHOPIFY_CLIENT_SECRET,
  });

  const runLog = [];
  const { processed, failed } = await runBatch({ shopify, config, mode, limit, runLog });

  log(`Run finished. Processed: ${processed}, Failed: ${failed}.`);

  // Write a small log file the dashboard (docs/index.html) can fetch and display.
  const logPayload = {
    mode,
    finished_at: new Date().toISOString(),
    processed,
    failed,
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
