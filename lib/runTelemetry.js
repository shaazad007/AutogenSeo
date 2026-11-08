"use strict";

function githubRunIdentity(env = process.env, suppliedLogicalJobId = "") {
  const runId = Number(env.GITHUB_RUN_ID);
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(runId) || runId < 1 ||
      !Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    return null;
  }
  const logicalJobId = suppliedLogicalJobId || env.INPUT_LOGICAL_JOB_ID || `ghjob_${runId}`;
  if (typeof logicalJobId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,120}$/.test(logicalJobId)) {
    return null;
  }
  return {
    logical_job_id: logicalJobId,
    workflow_run_id: runId,
    github_run_attempt: runAttempt,
  };
}

function updateCurrentRun(progress, {
  identity,
  status,
  total,
  completed,
  failed,
  skipped = 0,
  updatedAt = new Date().toISOString(),
}) {
  if (!identity || !Number.isSafeInteger(total) || total < 0 ||
      ![completed, failed, skipped].every((count) => Number.isSafeInteger(count) && count >= 0)) {
    return false;
  }
  progress.current_run = {
    ...identity,
    product_status: status,
    processed_products: completed + failed + skipped,
    total_products: total,
    completed_products: completed,
    failed_products: failed,
    skipped_products: skipped,
    updated_at: updatedAt,
  };
  return true;
}

module.exports = { githubRunIdentity, updateCurrentRun };
