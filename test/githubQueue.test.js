"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  emptyQueueState,
  enqueueCollections,
  loadQueueState,
  saveQueueState,
  activeJob,
  recordProductResult,
  mergeNewEligibleProducts,
  pendingProductIds,
  finishJobRun,
} = require("../lib/githubQueue");

const products = (prefix, count) => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index + 1}`,
  title: `${prefix} product ${index + 1}`,
}));

test("one request creates ordered per-collection jobs and first collection owns overlaps", () => {
  const state = emptyQueueState();
  const result = enqueueCollections(state, [
    { handle: "abx", title: "ABX", products: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }] },
    { handle: "maria-b", title: "Maria B", products: [{ id: "4" }, { id: "5" }, { id: "6" }] },
    { handle: "khaadi", title: "Khaadi", products: [{ id: "6" }, { id: "7" }] },
  ], { requestId: "request-1" });
  assert.equal(result.jobs.length, 3);
  assert.deepEqual(state.jobs.map((job) => job.collection_handle), ["abx", "maria-b", "khaadi"]);
  assert.deepEqual(state.jobs.map((job) => job.status), ["queued", "queued", "queued"]);
  assert.equal(activeJob(state), state.jobs[0]);
  assert.deepEqual(state.jobs.map((job) => job.items.map((item) => item.product_id)), [
    ["1", "2", "3", "4"], ["5", "6"], ["7"],
  ]);
  assert.equal(enqueueCollections(state, [{ handle: "abx", products: [{ id: "8" }] }], { requestId: "request-1" }).duplicate, true);
});

test("collection publication criteria persist on the queue job for worker refreshes", () => {
  const state = emptyQueueState();
  enqueueCollections(state, [{
    handle: "imrozia",
    products: [{ id: "new-1" }],
    criteria: {
      published_from: "2026-11-02T00:00:00.000Z",
      published_before: "2026-11-04T00:00:00.000Z",
    },
  }], { requestId: "date-window" });
  assert.deepEqual(state.jobs[0].criteria, {
    published_from: "2026-11-02T00:00:00.000Z",
    published_before: "2026-11-04T00:00:00.000Z",
  });
});

test("349 products continue across runs with the same logical job and no duplicate completions", () => {
  const state = emptyQueueState();
  enqueueCollections(state, [
    { handle: "abx", products: products("p", 349) },
    { handle: "maria-b", products: [{ id: "later-1" }] },
  ], { requestId: "349-run" });
  const first = activeJob(state);
  const stableId = first.queue_job_id;
  for (const id of pendingProductIds(first).slice(0, 160)) recordProductResult(first, id, "completed");
  const run1 = finishJobRun(state, first, { madeProgress: true });
  assert.equal(first.status, "waiting_continuation");
  assert.equal(first.completed, 160);
  assert.equal(first.remaining, 189);
  assert.equal(run1.continuationReason, "remaining_products");
  assert.equal(activeJob(state), first);

  for (const id of pendingProductIds(first).slice(0, 160)) recordProductResult(first, id, "completed");
  finishJobRun(state, first, { madeProgress: true });
  assert.equal(first.queue_job_id, stableId);
  assert.equal(first.completed, 320);
  assert.equal(first.remaining, 29);
  assert.equal(activeJob(state), first);

  for (const id of pendingProductIds(first)) recordProductResult(first, id, "completed");
  const finalRun = finishJobRun(state, first, { madeProgress: true });
  assert.equal(first.status, "completed");
  assert.equal(first.remaining, 0);
  assert.equal(finalRun.continuationReason, "next_collection");
  assert.equal(activeJob(state).collection_handle, "maria-b");
  assert.equal(new Set(first.completed_product_ids).size, 349);
});

test("time budget, provider quota, and daily cap preserve the same active logical job", () => {
  for (const scenario of [
    { stopReason: "time_budget", status: "waiting_time_budget", continuation: true },
    { stopReason: "daily_quota", status: "waiting_provider_quota", continuation: false },
    { stopReason: null, dailyCapReached: true, status: "waiting_daily_cap", continuation: false },
  ]) {
    const state = emptyQueueState();
    enqueueCollections(state, [{ handle: "abx", products: products("q", 3) }], { requestId: scenario.status });
    const job = activeJob(state);
    const id = job.queue_job_id;
    const result = finishJobRun(state, job, { ...scenario, madeProgress: true });
    assert.equal(job.status, scenario.status);
    assert.equal(activeJob(state).queue_job_id, id);
    assert.equal(Boolean(result.continuationReason), scenario.continuation);
    assert.equal(job.remaining, 3);
  }
});

test("newly eligible products are prioritized before older pending backlog", () => {
  const state = emptyQueueState();
  enqueueCollections(state, [{ handle: "abx", products: [{ id: "old-1" }, { id: "old-2" }] }], { requestId: "new-priority" });
  const job = activeJob(state);
  assert.equal(mergeNewEligibleProducts(state, job, [{ id: "new-1" }, { id: "new-2" }, { id: "old-1" }]), 2);
  assert.deepEqual(pendingProductIds(job), ["new-1", "new-2", "old-1", "old-2"]);
});

test("queue state survives restart and completed IDs stay settled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "github-queue-"));
  const file = path.join(dir, "docs", "queue_state.json");
  const state = emptyQueueState();
  enqueueCollections(state, [{ handle: "abx", products: [{ id: "a" }, { id: "b" }] }], { requestId: "persist" });
  const job = activeJob(state);
  recordProductResult(job, "a", "completed");
  saveQueueState(file, state);
  const restarted = loadQueueState(file);
  assert.equal(activeJob(restarted).queue_job_id, job.queue_job_id);
  assert.deepEqual(activeJob(restarted).completed_product_ids, ["a"]);
  assert.deepEqual(pendingProductIds(activeJob(restarted)), ["b"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("active collection completion advances only when remaining reaches zero", () => {
  const state = emptyQueueState();
  enqueueCollections(state, [
    { handle: "first", products: [{ id: "a" }, { id: "b" }] },
    { handle: "second", products: [{ id: "c" }] },
  ], { requestId: "advance" });
  const first = activeJob(state);
  recordProductResult(first, "a", "completed");
  finishJobRun(state, first, { madeProgress: true });
  assert.equal(activeJob(state), first);
  assert.equal(state.jobs[1].status, "queued");
  recordProductResult(first, "b", "completed");
  finishJobRun(state, first, { madeProgress: true });
  assert.equal(activeJob(state).collection_handle, "second");
});
