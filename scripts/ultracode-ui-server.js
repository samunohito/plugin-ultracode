#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const http = require("http");
const path = require("path");
const { displayRunName } = require("./run-identity");
const { readWorkflow } = require("./ultracode-engine");
const scriptRunner = require("./ultracode-script-runner");
const workflowDefinitions = require("./workflow-definitions");

const STATIC_DIR = path.join(__dirname, "..", "ui");
const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
  [".ico", "image/x-icon"]
]);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

const runsDir = path.resolve(requiredEnv("ULTRACODE_UI_RUNS_DIR"));
const metaPath = path.resolve(requiredEnv("ULTRACODE_UI_META_PATH"));
const host = (process.env.ULTRACODE_UI_HOST || "127.0.0.1").trim();
const port = Math.max(0, Math.floor(Number(process.env.ULTRACODE_UI_PORT || 0)));
const idleTimeoutMs = Math.max(60_000, Math.floor(Number(process.env.ULTRACODE_UI_IDLE_TIMEOUT_MS || 30 * 60_000)));
const HOOK_SESSION_NAMESPACES = ["loop", "peer"];
let lastRequestAt = Date.now();
let serverUrl = null;

function json(res, statusCode, body) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}

function text(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function safeWorkflowId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

async function readWorkflowFile(filePath) {
  return readWorkflow({ state_path: filePath });
}

async function workflowFiles() {
  let entries;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(runsDir, entry.name));
  const stats = await Promise.all(files.map(async (file) => ({ file, stat: await fs.stat(file) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats;
}

async function latestWorkflow() {
  const files = await workflowFiles();
  if (files.length === 0) return null;
  return readWorkflowFile(files[0].file);
}

async function workflowById(id) {
  const safe = safeWorkflowId(id);
  if (!safe) return null;
  try {
    return await readWorkflowFile(path.join(runsDir, `${safe}.json`));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function requestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function workflowDefinitionContext(parsed) {
  const explicitCwd = parsed.searchParams.get("cwd");
  if (explicitCwd) return { cwd: explicitCwd };
  const latest = await latestWorkflow();
  return { cwd: (latest && latest.cwd) || process.cwd() };
}

function stripDefinitionSource(definition) {
  const { source, ...summary } = definition;
  return summary;
}

function summarize(record, stat) {
  const workers = Array.isArray(record.workers) && record.workers.length > 0 ? record.workers : Array.isArray(record.steps) ? record.steps : [];
  const displayName = displayRunName(record);
  return {
    id: record.id,
    name: record.name || null,
    display_name: displayName,
    slug: record.slug || null,
    kind: record.kind || (record.options && record.options.pipeline ? "pipeline" : "run"),
    status: record.status,
    task: record.task || null,
    cwd: record.cwd || null,
    started_at: record.started_at || null,
    completed_at: record.completed_at || null,
    duration_ms: record.duration_ms || null,
    workers: workers.length,
    running: workers.filter((worker) => worker.status === "running").length,
    pending: workers.filter((worker) => worker.status === "pending").length,
    completed: workers.filter((worker) => worker.status === "completed").length,
    failed: workers.filter((worker) => worker.status === "failed").length,
    cancelled: workers.filter((worker) => worker.status === "cancelled").length,
    updated_at: stat ? new Date(stat.mtimeMs).toISOString() : null
  };
}

async function listWorkflows() {
  const files = await workflowFiles();
  const records = [];
  for (const item of files.slice(0, 40)) {
    try {
      records.push(summarize(await readWorkflowFile(item.file), item.stat));
    } catch {
      records.push({ id: path.basename(item.file, ".json"), status: "unreadable" });
    }
  }
  return records;
}

function codexHomeForSessions() {
  if (process.env.CODEX_HOME) return path.resolve(process.env.CODEX_HOME);
  return path.join(process.env.HOME || process.cwd(), ".codex");
}

function normalizeReview(review) {
  if (!review || typeof review !== "object") return null;
  return {
    at: typeof review.at === "string" ? review.at : null,
    kind: typeof review.kind === "string" ? review.kind : "review",
    decision: typeof review.decision === "string" ? review.decision : null,
    prompt: typeof review.prompt === "string" ? review.prompt : null,
    amended_prompt: typeof review.amended_prompt === "string" ? review.amended_prompt : null,
    review: typeof review.review === "string" ? review.review : "",
    next_prompt: typeof review.next_prompt === "string" ? review.next_prompt : null,
    confidence: typeof review.confidence === "string" ? review.confidence : null,
    model: typeof review.model === "string" ? review.model : null,
    backend: typeof review.backend === "string" ? review.backend : null
  };
}

function latestSessionTimestamp(session) {
  const reviewTimes = (session.reviews || []).map((review) => Date.parse(review.at || "")).filter(Number.isFinite);
  const candidates = [
    Date.parse(session.updated_at || ""),
    Date.parse(session.activated_at || ""),
    ...reviewTimes
  ].filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

async function readHookSessionFile(namespace, filePath) {
  const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  const reviews = Array.isArray(raw.reviews) ? raw.reviews.map(normalizeReview).filter(Boolean).slice(-50) : [];
  return {
    id: path.basename(filePath, ".json"),
    namespace,
    goal: typeof raw.goal === "string" ? raw.goal : "",
    activated_at: typeof raw.activated_at === "string" ? raw.activated_at : null,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    continues: Number.isFinite(Number(raw.continues)) ? Number(raw.continues) : null,
    review_count: reviews.length,
    reviews,
    latest_at: null
  };
}

async function listHookSessions() {
  const codex_home = codexHomeForSessions();
  const sessions = [];
  for (const namespace of HOOK_SESSION_NAMESPACES) {
    const dir = path.join(codex_home, namespace, "sessions");
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(dir, entry.name));
    for (const file of files) {
      try {
        sessions.push(await readHookSessionFile(namespace, file));
      } catch {
        sessions.push({ id: path.basename(file, ".json"), namespace, unreadable: true, reviews: [], review_count: 0 });
      }
    }
  }
  for (const session of sessions) {
    const timestamp = latestSessionTimestamp(session);
    session.latest_at = timestamp ? new Date(timestamp).toISOString() : null;
  }
  sessions.sort((a, b) => latestSessionTimestamp(b) - latestSessionTimestamp(a));
  return { codex_home, sessions };
}

function enrichWorkflow(record) {
  if (!record || typeof record !== "object") return record;
  if (record.display_name) return record;
  return {
    ...record,
    display_name: displayRunName(record)
  };
}

async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(STATIC_DIR, requested);
  if (!filePath.startsWith(`${STATIC_DIR}${path.sep}`) && filePath !== path.join(STATIC_DIR, "index.html")) {
    text(res, 403, "Forbidden\n");
    return;
  }
  let data;
  try {
    data = await fs.readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      text(res, 404, "Not found\n");
      return;
    }
    throw error;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, {
    "content-type": MIME.get(ext) || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "no-cache"
  });
  res.end(data);
}

async function handle(req, res) {
  lastRequestAt = Date.now();
  const parsed = new URL(req.url || "/", serverUrl || `http://${host}:${port}`);
  const pathname = parsed.pathname;

  if (pathname === "/api/health") {
    json(res, 200, { ok: true, pid: process.pid, runs_dir: runsDir, url: serverUrl });
    return;
  }
  if (pathname === "/api/workflows") {
    json(res, 200, { workflows: await listWorkflows() });
    return;
  }
  if (pathname === "/api/workflows/latest") {
    const record = await latestWorkflow();
    if (!record) {
      json(res, 404, { error: "No Ultracode workflow records found.", runs_dir: runsDir });
      return;
    }
    json(res, 200, enrichWorkflow(record));
    return;
  }
  if (pathname === "/api/hook-sessions") {
    json(res, 200, await listHookSessions());
    return;
  }
  if (pathname === "/api/workflow-definitions") {
    if (req.method === "GET") {
      json(res, 200, { workflows: await workflowDefinitions.listWorkflowDefinitions(await workflowDefinitionContext(parsed)) });
      return;
    }
    if (req.method === "POST") {
      const body = await requestJson(req);
      let source = body.source;
      let cwd = body.cwd || null;
      let name = body.name || null;
      if (!source && body.workflow_id) {
        const record = await workflowById(String(body.workflow_id));
        if (!record) {
          json(res, 404, { error: "Workflow record not found.", id: body.workflow_id });
          return;
        }
        const scriptPath = record.script_path || record.source_path;
        if (!scriptPath) {
          json(res, 400, { error: "Workflow record does not include a script_path or source_path." });
          return;
        }
        source = await fs.readFile(scriptPath, "utf8");
        cwd = cwd || record.cwd;
        name = name || (record.meta && record.meta.name) || record.name || record.slug || record.id;
      }
      const saved = await workflowDefinitions.saveWorkflowDefinition({
        name,
        source,
        cwd: cwd || (await workflowDefinitionContext(parsed)).cwd,
        scope: body.scope || "project",
        codex_home: body.codex_home || null
      });
      json(res, 200, { saved: true, workflow: stripDefinitionSource(saved) });
      return;
    }
    json(res, 405, { error: "Method not allowed." });
    return;
  }
  const definitionMatch = /^\/api\/workflow-definitions\/([^/]+)$/.exec(pathname);
  if (definitionMatch) {
    const id = decodeURIComponent(definitionMatch[1]);
    const context = await workflowDefinitionContext(parsed);
    if (req.method === "GET") {
      const definition = await workflowDefinitions.resolveWorkflowDefinition(id, context);
      json(res, 200, definition);
      return;
    }
    if (req.method === "PUT" || req.method === "PATCH") {
      const body = await requestJson(req);
      const updated = await workflowDefinitions.updateWorkflowDefinition(id, {
        ...context,
        source: body.source
      });
      json(res, 200, { saved: true, workflow: stripDefinitionSource(updated) });
      return;
    }
    if (req.method === "DELETE") {
      const deleted = await workflowDefinitions.deleteWorkflowDefinition(id, context);
      json(res, 200, { deleted: true, workflow: deleted });
      return;
    }
    json(res, 405, { error: "Method not allowed." });
    return;
  }
  const definitionRunMatch = /^\/api\/workflow-definitions\/([^/]+)\/run$/.exec(pathname);
  if (definitionRunMatch) {
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed." });
      return;
    }
    const id = decodeURIComponent(definitionRunMatch[1]);
    const body = await requestJson(req);
    const context = await workflowDefinitionContext(parsed);
    const definition = await workflowDefinitions.resolveWorkflowDefinition(id, context);
    const record = await scriptRunner.runScript({
      path: definition.path,
      name: definition.name,
      args: body.args,
      cwd: body.cwd || context.cwd,
      codex_bin: body.codex_bin,
      codex_home: body.codex_home,
      state_dir: path.dirname(runsDir),
      concurrency: body.concurrency,
      budget_tokens: body.budget_tokens,
      max_agents: body.max_agents,
      launch_stagger_ms: body.launch_stagger_ms,
      claude_compat: true,
      ui: false,
      definition_ref: {
        id: definition.id,
        name: definition.name,
        scope: definition.scope,
        path: definition.path,
        source_hash: definition.source_hash
      }
    });
    json(res, 200, {
      started: true,
      workflow_id: record.id,
      status: record.status,
      url: `${serverUrl}/workflow/${encodeURIComponent(record.id)}`,
      record: enrichWorkflow(record)
    });
    return;
  }
  const workflowMatch = /^\/api\/workflows\/([^/]+)$/.exec(pathname);
  if (workflowMatch) {
    const record = await workflowById(decodeURIComponent(workflowMatch[1]));
    if (!record) {
      json(res, 404, { error: "Workflow record not found.", id: workflowMatch[1] });
      return;
    }
    json(res, 200, enrichWorkflow(record));
    return;
  }
  if (pathname === "/" || pathname.startsWith("/workflow/")) {
    await serveStatic(res, "/index.html");
    return;
  }
  await serveStatic(res, pathname);
}

async function writeMetadata(url) {
  const payload = {
    pid: process.pid,
    url,
    host,
    port: Number(new URL(url).port),
    runs_dir: runsDir,
    static_dir: STATIC_DIR,
    started_at: new Date().toISOString()
  };
  await fs.mkdir(path.dirname(metaPath), { recursive: true });
  const tmp = `${metaPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmp, metaPath);
}

async function removeMetadata() {
  try {
    const current = JSON.parse(await fs.readFile(metaPath, "utf8"));
    if (current.pid === process.pid) await fs.rm(metaPath, { force: true });
  } catch {
    /* metadata cleanup is best-effort */
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(port, host, async () => {
  const address = server.address();
  serverUrl = `http://${host}:${address.port}`;
  try {
    await writeMetadata(serverUrl);
  } catch (error) {
    process.stderr.write(`[ultracode-ui] failed to write metadata: ${error.message}\n`);
    process.exit(1);
  }
});

setInterval(() => {
  if (Date.now() - lastRequestAt > idleTimeoutMs) {
    server.close(() => {
      removeMetadata().finally(() => process.exit(0));
    });
  }
}, 30_000).unref();

process.on("SIGTERM", () => {
  server.close(() => {
    removeMetadata().finally(() => process.exit(0));
  });
});
