"use strict";
const path = require("path");

// State roots contain runs/, scripts/, and ui/. They never supply worker auth.
function stateRoot(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const value = options.state_dir ?? process.env.ULTRACODE_STATE_DIR;
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    throw new Error("state_dir must be a non-empty string.");
  }
  return path.resolve(cwd, value === undefined ? ".codex/ultracode" : value.trim());
}
module.exports = { stateRoot };
