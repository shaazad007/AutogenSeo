"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { githubRunIdentity, updateCurrentRun } = require("../lib/runTelemetry");

test("GitHub run identity requires valid run ID and attempt", () => {
  assert.deepEqual(
    githubRunIdentity({ GITHUB_RUN_ID: "509", GITHUB_RUN_ATTEMPT: "3" }),
    {
      logical_job_id: "ghjob_509",
      workflow_run_id: 509,
      github_run_attempt: 3,
    },
  );
  assert.equal(githubRunIdentity({ GITHUB_RUN_ID: "509" }), null);
  assert.equal(
    githubRunIdentity({ GITHUB_RUN_ID: "0", GITHUB_RUN_ATTEMPT: "1" }),
    null,
  );
});

test("progress snapshot keeps workflow identity separate from product counts", () => {
  const progress = { total_products: 10000 };
  const identity = {
    logical_job_id: "job_12345",
    workflow_run_id: 509,
    github_run_attempt: 3,
  };
  assert.equal(updateCurrentRun(progress, {
    identity,
    status: "running",
    total: 8,
    completed: 3,
    failed: 1,
    updatedAt: "2026-11-08T00:00:00Z",
  }), true);
  assert.equal(progress.total_products, 10000);
  assert.deepEqual(progress.current_run, {
    ...identity,
    product_status: "running",
    processed_products: 4,
    total_products: 8,
    completed_products: 3,
    failed_products: 1,
    skipped_products: 0,
    updated_at: "2026-11-08T00:00:00Z",
  });
});

test("missing identity leaves progress untouched", () => {
  const progress = { total_products: 5 };
  assert.equal(updateCurrentRun(progress, {
    identity: null,
    status: "running",
    total: 2,
    completed: 0,
    failed: 0,
  }), false);
  assert.deepEqual(progress, { total_products: 5 });
});
