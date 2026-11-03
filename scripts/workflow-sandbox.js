"use strict";

const vm = require("vm");

// Claude-compatible workflow scripts run in a fresh V8 context instead of the
// host realm: only ECMAScript built-ins plus the bound primitives are in scope,
// so `process`, `require`, `setTimeout`, `Buffer`, and the rest of the Node
// host are simply undefined (Claude's Workflow: "No filesystem or Node.js API
// access"). This is an isolation boundary for honest scripts, not a security
// boundary against hostile ones — node:vm is not that.
//
// The context also removes the non-deterministic clocks Claude forbids, since
// they would make a resumed run diverge from the journal it replays:
// `Date.now()`, `Date()`, argless `new Date()`, and `Math.random()` throw.
// `new Date(value)`, `Date.parse`, and `Date.UTC` keep working.

const DETERMINISM_PRELUDE = `(() => {
  "use strict";
  const RealDate = Date;
  const unavailable = (what) => {
    throw new Error(
      what + " is not available in Claude-compatible workflow scripts (it would break resume); " +
        "pass timestamps in via args or stamp results after the workflow returns."
    );
  };
  const GuardedDate = function Date(...args) {
    if (!new.target) unavailable("Date()");
    if (args.length === 0) unavailable("new Date()");
    return Reflect.construct(RealDate, args, new.target);
  };
  Object.setPrototypeOf(GuardedDate, RealDate);
  GuardedDate.prototype = RealDate.prototype;
  GuardedDate.now = () => unavailable("Date.now()");
  Object.defineProperty(RealDate.prototype, "constructor", { value: GuardedDate, writable: true, configurable: true });
  globalThis.Date = GuardedDate;
  Math.random = () => unavailable("Math.random()");
})();`;

// Compile `body` (already transformed by the script runner) as an async
// function of `params` inside a new context. Returns the callable function;
// a SyntaxError surfaces from here exactly like the AsyncFunction constructor.
function compileSandboxedScript(body, params, filename = "workflow.js") {
  const context = vm.createContext({}, { name: "ultracode-workflow", codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(DETERMINISM_PRELUDE, context);
  return vm.runInContext(`(async function (${params.join(", ")}) {\n${body}\n})`, context, { filename });
}

module.exports = { compileSandboxedScript };
