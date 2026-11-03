"use strict";

const childProcess = require("child_process");
const fs = require("fs/promises");
const http = require("http");
const path = require("path");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_WAIT_MS = 2500;

function parseBool(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  if (["1", "true", "yes", "on", "enabled", ""].includes(normalized)) return true;
  return true;
}

function shouldLaunchUi(input = {}) {
  const explicit = parseBool(input.ui);
  if (explicit !== undefined) return explicit;
  const env = parseBool(process.env.ULTRACODE_UI);
  return env === true;
}

function emitUiEvent(ctx, event) {
  if (!ctx) return;
  const stamped = { at: new Date().toISOString(), ...event };
  if (Array.isArray(ctx.events)) ctx.events.push(stamped);
  if (typeof ctx.onEvent === "function") {
    try {
      ctx.onEvent(stamped);
    } catch {
      /* UI progress hooks must never break worker execution */
    }
  }
}

function metadataPathForRunsDir(runsDir) {
  return path.join(path.dirname(runsDir), "ui", "server.json");
}

async function readMetadata(metaPath) {
  try {
    return JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function requestHealth(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url.replace(/\/$/, "")}/api/health`, { timeout: 600 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function healthyMetadata(metaPath, runsDir) {
  const meta = await readMetadata(metaPath);
  if (!meta || meta.runs_dir !== runsDir || typeof meta.url !== "string") return null;
  return (await requestHealth(meta.url)) ? meta : null;
}

async function waitForMetadata(metaPath, timeoutMs) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await readMetadata(metaPath);
    if (last && typeof last.url === "string" && Number.isInteger(last.pid)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

async function startServer(runsDir, metaPath, input = {}) {
  await fs.mkdir(path.dirname(metaPath), { recursive: true });
  await fs.rm(metaPath, { force: true });

  const serverPath = path.join(__dirname, "ultracode-ui-server.js");
  const env = {
    ...process.env,
    ULTRACODE_UI_RUNS_DIR: runsDir,
    ...(input.codex_home ? { CODEX_HOME: input.codex_home } : {}),
    ULTRACODE_UI_META_PATH: metaPath,
    ULTRACODE_UI_HOST: typeof input.ui_host === "string" && input.ui_host.trim() ? input.ui_host.trim() : DEFAULT_HOST,
    ULTRACODE_UI_PORT:
      input.ui_port === undefined || input.ui_port === null || input.ui_port === "" ? "0" : String(input.ui_port)
  };

  const child = childProcess.spawn(process.execPath, [serverPath], {
    detached: true,
    env,
    stdio: "ignore"
  });
  child.unref();

  const meta = await waitForMetadata(metaPath, DEFAULT_WAIT_MS);
  if (!meta || typeof meta.url !== "string") {
    throw new Error(`UI server did not publish metadata at ${metaPath}`);
  }
  return meta;
}

async function ensureUiServer(runsDir, input = {}) {
  const metaPath = metadataPathForRunsDir(runsDir);
  const existing = await healthyMetadata(metaPath, runsDir);
  if (existing) return existing;
  return startServer(runsDir, metaPath, input);
}

async function attachWorkflowUi(record, ctx, input = {}) {
  if (!record || !record.state_path || !shouldLaunchUi(input)) return null;

  const launchedAt = new Date().toISOString();
  try {
    const runsDir = path.dirname(record.state_path);
    const server = await ensureUiServer(runsDir, input);
    const serverUrl = server.url.replace(/\/$/, "");
    const url = `${serverUrl}/workflow/${encodeURIComponent(record.id)}`;
    const ui = {
      status: "ready",
      url,
      server_url: serverUrl,
      server_pid: server.pid,
      state_path: record.state_path,
      launched_at: launchedAt
    };
    record.ui = ui;
    emitUiEvent(ctx, {
      type: "ui.ready",
      message: `UI ready at ${url}`,
      workflow_id: record.id,
      url,
      server_pid: server.pid
    });
    return ui;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record.ui = { status: "failed", error: message, launched_at: launchedAt };
    emitUiEvent(ctx, {
      type: "ui.failed",
      message: `UI launch failed: ${message}`,
      workflow_id: record.id
    });
    process.stderr.write(`[ultracode] UI launch failed: ${message}\n`);
    return null;
  }
}

module.exports = {
  attachWorkflowUi,
  ensureUiServer,
  metadataPathForRunsDir,
  shouldLaunchUi
};
