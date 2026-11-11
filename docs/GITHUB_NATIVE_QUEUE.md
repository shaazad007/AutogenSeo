# GitHub Native Collection Queue

## Architecture

The Flutter app submits one `workflow_dispatch` request with collection handles
in the user's selected order. GitHub Actions uses the repository's Shopify
secrets to discover eligible products, filters `ai-done`, and stores the queue
in `docs/queue_state.json`. The app reads that public file directly; no hosted
queue API or Shopify write from the app is required.

The queue state contains `schema_version`, request idempotency keys, and ordered
logical jobs. Each job records its stable `queue_job_id`, collection handle and
title, mode, submission order, product IDs, item statuses, completed/skipped/
failed IDs and counts, remaining count, run IDs/attempt history, wait reason,
and timestamps. Shopify and AI credentials are never stored in the state.

Only the first queued or waiting collection is processed. Every worker run
rechecks that collection for newly eligible products and puts new IDs before
its older pending items. Product IDs are fetched exactly and passed through the
existing `runBatch` SEO/provider fallback. Missing or `ai-done` products become
skipped. Product failures remain visible; the existing scheduled catalog scan
continues to retry products without `ai-done`.

The same logical job stays active across runs. Time-budget stops continue only
after progress; provider quota and daily-cap waits resume on a later scheduled
run. The next selected collection starts only after the active job has no
remaining items, and not after the daily cap has been reached.

## GitHub permissions and writes

The worker needs `contents: write` to commit progress and queue state and
`actions: write` to dispatch its next `workflow_dispatch` run. GitHub documents
that `workflow_dispatch` events initiated with `GITHUB_TOKEN` create runs; no
PAT is required when the repository grants those permissions. Workflow files
must be present on the default branch for production dispatch. A concurrency
group serializes enqueue and worker runs, a persisted pending-dispatch marker
prevents duplicate continuation requests, and the final commit step rebases
before push. A queue-state conflict fails visibly instead of replacing newer
state.

Mobile workflow dispatch uses the existing GitHub App Device Flow. The app
needs repository access and its configured permissions must include Actions
write for workflow dispatch. The device token continues to use
`offline_access` for refresh. The app's remote permission configuration was not
inspectable from this local checkout; a 403 should be resolved by enabling
Actions write in the GitHub App and reauthorizing the device.

## Verification status

The queue module and exact-ID processor adapter are on the
`codex/github-native-queue` branch. Offline queue and Shopify-priority tests
passed at an intermediate checkpoint. Later app/workflow edits have not been
retested, per the owner's instruction not to run tests or builds. No live
Shopify or GitHub processing was triggered. The queue is not production-active
until the branch is reviewed and merged to the default branch.
