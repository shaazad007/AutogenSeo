"use strict";

const fs = require("fs");

const SCHEMA_VERSION = 1;
const ACTIVE_STATUSES = new Set([
  "queued",
  "running",
  "waiting_continuation",
  "waiting_time_budget",
  "waiting_provider_quota",
  "waiting_daily_cap",
]);

function emptyQueueState() {
  return { schema_version: SCHEMA_VERSION, updated_at: null, jobs: [], requests: [] };
}

function loadQueueState(filePath) {
  if (!fs.existsSync(filePath)) return emptyQueueState();
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (state.schema_version !== SCHEMA_VERSION || !Array.isArray(state.jobs)) {
    throw new Error(`Unsupported or invalid queue state at ${filePath}`);
  }
  if (!Array.isArray(state.requests)) state.requests = [];
  return state;
}

function saveQueueState(filePath, state) {
  state.updated_at = new Date().toISOString();
  fs.mkdirSync(require("path").dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function enqueueCollections(state, collections, { requestId, mode = "live", now = new Date().toISOString() } = {}) {
  if (!requestId || typeof requestId !== "string") throw new Error("enqueue request ID is required");
  if (!["live", "preview"].includes(mode)) throw new Error("queue mode must be live or preview");
  if (state.requests.includes(requestId)) return { state, jobs: [], duplicate: true };
  const seen = new Set(state.jobs.flatMap((job) => (job.items || []).map((item) => item.product_id)));
  const created = [];
  for (let index = 0; index < collections.length; index += 1) {
    const collection = collections[index];
    const items = [];
    for (const product of collection.products || []) {
      if (!product || !product.id || seen.has(product.id)) continue;
      seen.add(product.id);
      items.push({ product_id: product.id, title: product.title || "", status: "pending", attempts: 0 });
    }
    const job = {
      queue_job_id: `${requestId}:${index + 1}`,
      collection_handle: collection.handle,
      collection_title: collection.title || collection.handle,
      mode,
      submission_order: state.jobs.length + index + 1,
      created_at: now,
      updated_at: now,
      status: items.length ? "queued" : "completed",
      total: items.length,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: items.length,
      items,
      completed_product_ids: [],
      skipped_product_ids: [],
      failed_product_ids: [],
      current_run_id: null,
      last_run_id: null,
      run_history: [],
      wait_reason: items.length ? null : "no_eligible_products",
      continuation_attempts: 0,
      last_continuation_from_run_id: null,
    };
    state.jobs.push(job);
    created.push(job);
  }
  state.requests.push(requestId);
  return { state, jobs: created, duplicate: false };
}

function activeJob(state) {
  return state.jobs.find((job) => ACTIVE_STATUSES.has(job.status)) || null;
}

function recomputeJobCounts(job) {
  job.completed = job.items.filter((item) => item.status === "completed").length;
  job.skipped = job.items.filter((item) => item.status === "skipped").length;
  job.failed = job.items.filter((item) => item.status === "failed").length;
  job.remaining = job.items.filter((item) => item.status === "pending" || item.status === "processing").length;
  job.completed_product_ids = job.items.filter((item) => item.status === "completed").map((item) => item.product_id);
  job.skipped_product_ids = job.items.filter((item) => item.status === "skipped").map((item) => item.product_id);
  job.failed_product_ids = job.items.filter((item) => item.status === "failed").map((item) => item.product_id);
  job.updated_at = new Date().toISOString();
  if (job.remaining === 0 && job.status !== "failed") {
    job.status = job.failed ? "completed_with_failures" : "completed";
    job.wait_reason = null;
  }
  return job;
}

function recordProductResult(job, productId, status, error = null) {
  const item = job.items.find((candidate) => candidate.product_id === productId);
  if (!item || !["completed", "skipped", "failed"].includes(status)) return false;
  if (item.status === "completed" || item.status === "skipped") return false;
  item.status = status;
  item.attempts += 1;
  item.last_error = error ? String(error).slice(0, 500) : null;
  item.updated_at = new Date().toISOString();
  recomputeJobCounts(job);
  return true;
}

function orderedJobs(state) {
  return [...state.jobs].sort((a, b) => a.submission_order - b.submission_order);
}

function mergeNewEligibleProducts(state, job, products) {
  const knownIds = new Set(state.jobs.flatMap((queued) => queued.items.map((item) => item.product_id)));
  const freshItems = (products || [])
    .filter((product) => product && product.id && !knownIds.has(product.id))
    .map((product) => ({ product_id: product.id, title: product.title || "", status: "pending", attempts: 0 }));
  const pending = job.items.filter((item) => item.status === "pending");
  const settled = job.items.filter((item) => item.status !== "pending");
  job.items = [...freshItems, ...pending, ...settled];
  job.total = job.items.length;
  recomputeJobCounts(job);
  return freshItems.length;
}

function pendingProductIds(job) {
  return job.items.filter((item) => item.status === "pending").map((item) => item.product_id);
}

function finishJobRun(state, job, { stopReason = null, dailyCapReached = false, madeProgress = false } = {}) {
  recomputeJobCounts(job);
  let continuationReason = null;
  if (job.remaining > 0) {
    if (dailyCapReached || stopReason === "daily_cap") {
      job.status = "waiting_daily_cap";
      job.wait_reason = "daily_cap";
    } else if (["daily_quota", "provider_limits"].includes(stopReason)) {
      job.status = "waiting_provider_quota";
      job.wait_reason = stopReason;
    } else if (stopReason === "time_budget") {
      job.status = "waiting_time_budget";
      job.wait_reason = "time_budget";
      if (madeProgress) continuationReason = "time_budget";
    } else {
      job.status = "waiting_continuation";
      job.wait_reason = "remaining_products";
      if (madeProgress) continuationReason = "remaining_products";
    }
  } else {
    const next = activeJob(state);
    if (next && dailyCapReached) {
      next.status = "waiting_daily_cap";
      next.wait_reason = "daily_cap";
    } else if (next) {
      continuationReason = "next_collection";
    }
  }
  return { job, nextJob: activeJob(state), continuationReason };
}

module.exports = {
  ACTIVE_STATUSES,
  emptyQueueState,
  enqueueCollections,
  loadQueueState,
  saveQueueState,
  activeJob,
  orderedJobs,
  recomputeJobCounts,
  recordProductResult,
  mergeNewEligibleProducts,
  pendingProductIds,
  finishJobRun,
};
