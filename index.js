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
const {
  loadQueueState,
  saveQueueState,
  enqueueCollections,
  activeJob,
  recomputeJobCounts,
  recordProductResult,
  mergeNewEligibleProducts,
  pendingProductIds,
  finishJobRun,
} = require("./lib/githubQueue");

function parseArgs() {
  const args = { mode: "preview", limit: 10, collectionHandle: "", collectionHandles: "", enqueueRequestId: "" };
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "mode") args.mode = value;
    if (key === "limit") args.limit = parseInt(value, 10);
    if (key === "collection-handle") args.collectionHandle = value || "";
    if (key === "collection-handles") args.collectionHandles = value || "";
    if (key === "enqueue-request-id") args.enqueueRequestId = value || "";
  }
  return args;
}

function currentRunId() {
  return process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
}

async function requestQueueContinuation(state, reason) {
  const runId = currentRunId();
  if (state.continuation_pending && state.continuation_dispatch_source_run_id !== runId) {
    log("A queue worker continuation is already pending; refusing to enqueue a duplicate worker.");
    return false;
  }
  if (state.last_dispatch_from_run_id === runId) {
    log("Queue continuation was already requested by this run; refusing a duplicate dispatch.");
    return false;
  }
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) {
    log("Queue continuation is waiting for the next schedule: GITHUB_TOKEN or GITHUB_REPOSITORY is unavailable.");
    return false;
  }
  state.last_dispatch_from_run_id = runId;
  const job = activeJob(state);
  if (job) {
    job.continuation_attempts = (job.continuation_attempts || 0) + 1;
    job.last_continuation_from_run_id = runId;
  }
  state.continuation_pending = true;
  state.continuation_dispatch_source_run_id = runId;
  state.last_dispatch_reason = reason;
  state.last_dispatch_at = new Date().toISOString();
  saveQueueState(config.paths.queueState, state);
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetch(`${apiBase}/repos/${repository}/actions/workflows/auto-process.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: "main",
      return_run_details: true,
      inputs: { mode: "queue-worker", limit: "100000" },
    }),
  });
  if (!response.ok && response.status !== 204) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GitHub queue continuation dispatch failed (${response.status}): ${detail.slice(0, 400)}`);
  }
  log(`Queued one worker continuation (${reason}); workflow concurrency serializes it after this run.`);
  return true;
}

function validateHandles(raw) {
  let handles;
  try { handles = JSON.parse(raw); } catch (_) { throw new Error("collection_handles must be a JSON array of Shopify handles."); }
  if (!Array.isArray(handles) || handles.length < 1 || handles.length > 100 ||
      handles.some((handle) => typeof handle !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle)) ||
      new Set(handles).size !== handles.length) {
    throw new Error("collection_handles must contain 1-100 unique lowercase Shopify handles.");
  }
  return handles;
}

async function enqueueCollectionRequest(shopify) {
  const handles = validateHandles(process.env.INPUT_COLLECTION_HANDLES || "");
  const collections = [];
  for (const handle of handles) {
    const gid = await shopify.getCollectionGidByHandle(handle);
    if (!gid) throw new Error(`Cannot enqueue unknown Shopify collection: ${handle}`);
    const products = await shopify.fetchAllUnprocessedCollectionProducts(handle);
    collections.push({ handle, title: shopify._collectionTitleCache?.[handle] || handle, products });
  }
  const state = loadQueueState(config.paths.queueState);
  const requestId = process.env.INPUT_ENQUEUE_REQUEST_ID || `${currentRunId()}:${process.env.GITHUB_RUN_ATTEMPT || "1"}`;
  const result = enqueueCollections(state, collections, {
    requestId,
    mode: process.env.INPUT_QUEUE_MODE || "live",
  });
  saveQueueState(config.paths.queueState, state);
  log(result.duplicate
    ? `Duplicate enqueue request ${requestId}; existing jobs were preserved.`
    : `Created ${result.jobs.length} collection queue jobs in selection order.`);
  if (activeJob(state)) await requestQueueContinuation(state, "enqueue");
}

async function runQueueWorker(shopify, { limit, deadlineMs }) {
  const state = loadQueueState(config.paths.queueState);
  const job = activeJob(state);
  if (!job) {
    log("GitHub durable queue is empty; no collection work to process.");
    return;
  }

  // Discover newly eligible products on every worker run and put them ahead of
  // this collection's older pending backlog. Submission order still owns the
  // active collection; later collections never start early.
  const fresh = await shopify.fetchAllUnprocessedCollectionProducts(job.collection_handle);
  state.continuation_pending = false;
  state.continuation_dispatch_source_run_id = null;
  mergeNewEligibleProducts(state, job, fresh);
  job.status = "running";
  job.wait_reason = null;
  job.current_run_id = currentRunId();
  job.last_run_id = currentRunId();
  job.run_history.push({ run_id: currentRunId(), attempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1), started_at: new Date().toISOString() });
  saveQueueState(config.paths.queueState, state);

  const pendingIds = pendingProductIds(job);
  const runLog = [];
  const result = await runBatch({
    shopify,
    config,
    mode: job.mode === "preview" ? "preview" : "live",
    limit,
    runLog,
    logicalJobId: job.queue_job_id,
    deadlineMs,
    productIds: pendingIds,
    onProductResult: async ({ productId, status, error }) => {
      recordProductResult(job, productId, status, error);
      saveQueueState(config.paths.queueState, state);
    },
  });

  const run = job.run_history[job.run_history.length - 1];
  run.finished_at = new Date().toISOString();
  run.processed = result.processed;
  run.failed = result.failed;
  run.stop_reason = result.stopReason || null;
  const progress = JSON.parse(fs.readFileSync(config.paths.progress, "utf8"));
  const dailyCap = config.promptConfig.daily_cap || 1400;
  const dailyCapReached = job.mode !== "preview" && progress.today_done >= dailyCap;
  const { continuationReason } = finishJobRun(state, job, {
    stopReason: result.stopReason === "daily_cap" ? "daily_cap" : result.stopReason,
    dailyCapReached,
    madeProgress: result.processed + result.failed > 0,
  });
  saveQueueState(config.paths.queueState, state);
  if (continuationReason) await requestQueueContinuation(state, continuationReason);
  log(`Queue ${job.queue_job_id}: ${job.completed}/${job.total} complete, ${job.remaining} remaining, ${job.failed} failed.`);
}

async function main() {
  let { mode, limit, collectionHandle } = parseArgs();

  if (!["preview", "live", "profile-backfill", "collections", "enqueue", "queue-worker", "scheduled"].includes(mode)) {
    throw new Error(`Unknown --mode "${mode}".`);
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

  if (mode === "enqueue") {
    await enqueueCollectionRequest(shopify);
    return;
  }

  if (mode === "queue-worker" || (mode === "scheduled" && activeJob(loadQueueState(config.paths.queueState)))) {
    await runQueueWorker(shopify, { limit, deadlineMs });
    return;
  }
  if (mode === "scheduled") mode = "live";

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
  const { processed, failed, stopReason, usedGroqCount, usedCloudflareCount } = await runBatch({
    shopify,
    config,
    mode,
    limit,
    runLog,
    logicalJobId: process.env.INPUT_LOGICAL_JOB_ID || "",
    deadlineMs,
  });

  const reasonNote =
    stopReason === "time_budget"
      ? " (stopped early: time budget reached — will resume next scheduled run)"
      : stopReason === "daily_quota"
      ? " (stopped early: all configured image providers exhausted their daily quotas — will resume next scheduled run)"
      : stopReason === "provider_limits"
      ? " (stopped early: all configured image providers are rate limited — will resume next scheduled run)"
      : "";
  const groqNote = usedGroqCount ? ` (${usedGroqCount} of those via Groq fallback)` : "";
  const cloudflareNote = usedCloudflareCount ? ` (${usedCloudflareCount} of those via Cloudflare fallback)` : "";
  log(`Run finished. Processed: ${processed}, Failed: ${failed}.${reasonNote}${groqNote}${cloudflareNote}`);

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
