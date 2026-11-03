"use strict";

// Preloaded into the test runner and every test file (see `npm test`). Run state
// lands in $CODEX_HOME/ultracode/runs regardless of a call's `codex_home`
// option, so a test that does not wrap itself in withCodexHome() would otherwise
// journal into the developer's real ~/.codex. Point CODEX_HOME at one temp dir
// for the whole run; test-file subprocesses inherit it instead of making more.

const fs = require("fs");
const os = require("os");
const path = require("path");

if (!process.env.ULTRACODE_TEST_CODEX_HOME) {
  process.env.ULTRACODE_TEST_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-test-codex-home-"));
}
process.env.CODEX_HOME = process.env.ULTRACODE_TEST_CODEX_HOME;
