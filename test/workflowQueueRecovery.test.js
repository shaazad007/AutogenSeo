"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(
  path.join(__dirname, "../.github/workflows/auto-process.yml"),
  "utf8",
);

test("workflow refreshes the selected branch tip before queue processing", () => {
  assert.match(workflow, /uses: actions\/checkout@v4\s+with:\s+ref: \$\{\{ github\.ref_name \}\}/);
  assert.match(workflow, /name: Refresh branch tip\s+run: git pull --ff-only origin "\$GITHUB_REF_NAME"/);
});

test("workflow dispatch carries publication window inputs into the enqueue step", () => {
  assert.match(workflow, /published_from:/);
  assert.match(workflow, /published_before:/);
  assert.match(workflow, /INPUT_PUBLISHED_FROM: \$\{\{ inputs\.published_from \}\}/);
  assert.match(workflow, /INPUT_PUBLISHED_BEFORE: \$\{\{ inputs\.published_before \}\}/);
});
