"use strict";

// Preloaded test isolation for worker auth and workflow journals.

const fs = require("fs");
const os = require("os");
const path = require("path");

if (!process.env.ULTRACODE_TEST_CODEX_HOME) {
  process.env.ULTRACODE_TEST_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-test-codex-home-"));
}
process.env.CODEX_HOME = process.env.ULTRACODE_TEST_CODEX_HOME;

process.env.ULTRACODE_STATE_DIR = path.join(process.env.ULTRACODE_TEST_CODEX_HOME, "state");
