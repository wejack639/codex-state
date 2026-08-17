import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CodexAppServerClient } from "./codex-app-server.mjs";

const codexRoot = process.env.CODEX_STATE_CODEX_ROOT || path.join(os.homedir(), ".codex");
const stateRoot = process.env.CODEX_STATE_DATA_ROOT || path.join(os.homedir(), ".codex-state");
const databasePath = path.join(codexRoot, "state_5.sqlite");
const sessionIndexPath = path.join(codexRoot, "session_index.jsonl");
const lockRoot = path.join(codexRoot, "thread-writer-locks");
const configPath = path.join(stateRoot, "config.json");
const petRoot = fileURLToPath(new URL("../public/pet/", import.meta.url));
const port = Number(process.env.CODEX_STATE_PORT || 43991);
const host = "127.0.0.1";
const statusCache = new Map();
const clients = new Set();
const execFileAsync = promisify(execFile);
let sessionIndexCache = { signature: null, names: new Map() };

const THREAD_QUERY = `
  SELECT id, title, name, cwd, source, rollout_path, preview,
         created_at_ms, updated_at_ms, recency_at_ms, is_pinned
  FROM threads
  WHERE archived = 0
    AND agent_path IS NULL
    AND (name <> '' OR title <> '' OR preview <> '')
  ORDER BY recency_at_ms DESC, id DESC
  LIMIT ?
`;

const THREAD_BY_ID_QUERY = `
  SELECT id, title, name, cwd, source, rollout_path, preview,
         created_at_ms, updated_at_ms, recency_at_ms, is_pinned
  FROM threads
  WHERE id = ?
    AND archived = 0
    AND agent_path IS NULL
  LIMIT 1
`;

export function isValidThreadId(threadId) {
  return typeof threadId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId);
}

export function codexThreadDeepLink(threadId) {
  if (!isValidThreadId(threadId)) throw new Error("threadId 无效");
  return `vscode://openai.chatgpt/local/${threadId}`;
}

export function normalizeThreadName(value) {
  if (typeof value !== "string") throw new Error("会话名称无效");
  const name = value.trim();
  if (!name) throw new Error("会话名称不能为空");
  if ([...name].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  })) throw new Error("会话名称不能包含换行或控制字符");
  if (Array.from(name).length > 80) throw new Error("会话名称不能超过 80 个字符");
  return name;
}

export function readPetPackage(directory = petRoot) {
  try {
    const manifestPath = path.join(directory, "pet.json");
    const manifestStat = statSync(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const spriteVersionNumber = manifest.spriteVersionNumber ?? 1;
    const spritesheetPath = typeof manifest.spritesheetPath === "string"
      ? manifest.spritesheetPath.trim()
      : "";
    if (spriteVersionNumber !== 1 && spriteVersionNumber !== 2) {
      throw new Error("spriteVersionNumber 只支持 1 或 2");
    }
    if (
      !/^[A-Za-z0-9._-]+\.(png|webp)$/i.test(spritesheetPath) ||
      path.basename(spritesheetPath) !== spritesheetPath
    ) {
      throw new Error("spritesheetPath 必须是当前目录中的 PNG 或 WebP 文件");
    }

    const spritesheetStat = statSync(path.join(directory, spritesheetPath));
    return {
      ok: true,
      pet: {
        id: typeof manifest.id === "string" && manifest.id.trim() ? manifest.id.trim() : "custom-pet",
        displayName: typeof manifest.displayName === "string" && manifest.displayName.trim()
          ? manifest.displayName.trim()
          : "Codex Pet",
        spriteVersionNumber,
        spritesheetPath,
        revision: [
          spritesheetPath,
          manifestStat.size,
          manifestStat.mtimeMs,
          spritesheetStat.size,
          spritesheetStat.mtimeMs,
        ].join(":"),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `宠物皮肤不可用：${error instanceof Error ? error.message : "未知错误"}`,
    };
  }
}

export function parseThreadNameIndex(text) {
  const names = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const name = typeof record.thread_name === "string" ? record.thread_name.trim() : "";
      if (isValidThreadId(record.id) && name) names.set(record.id, name);
    } catch {
      // The final line may be incomplete while Codex is appending a rename.
    }
  }
  return names;
}

function readThreadNameIndex() {
  if (!existsSync(sessionIndexPath)) return sessionIndexCache.names;
  try {
    const stat = statSync(sessionIndexPath);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (sessionIndexCache.signature === signature) return sessionIndexCache.names;
    sessionIndexCache = {
      signature,
      names: parseThreadNameIndex(readFileSync(sessionIndexPath, "utf8")),
    };
  } catch {
    // Keep the last complete index while another process is replacing the file.
  }
  return sessionIndexCache.names;
}

function findThread(threadId) {
  if (!existsSync(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(THREAD_BY_ID_QUERY).get(threadId) || null;
  } finally {
    database.close();
  }
}

async function openThreadInVSCode(thread) {
  if (process.platform !== "darwin") throw new Error("当前版本仅支持在 macOS 中唤起 VS Code");
  if (!thread.cwd || !existsSync(thread.cwd)) throw new Error(`工作区不存在：${thread.cwd || "路径为空"}`);

  // Focus/open the owning workspace first so VS Code delivers the extension URI
  // to the intended window, then navigate the Codex webview to this conversation.
  await execFileAsync("/usr/bin/open", ["-a", "Visual Studio Code", thread.cwd]);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await execFileAsync("/usr/bin/open", [codexThreadDeepLink(thread.id)]);
}

function readConfig() {
  try {
    const value = JSON.parse(readFileSync(configPath, "utf8"));
    return {
      trackedThreadIds: Array.isArray(value.trackedThreadIds)
        ? [...new Set(value.trackedThreadIds.filter((id) => typeof id === "string"))]
        : [],
    };
  } catch {
    return { trackedThreadIds: [] };
  }
}

function writeConfig(config) {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, configPath);
}

function readTail(filePath, maxBytes = 512 * 1024) {
  const stat = statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(filePath, "r");
  try {
    readSync(descriptor, buffer, 0, length, start);
  } finally {
    closeSync(descriptor);
  }

  let text = buffer.toString("utf8");
  if (start > 0) {
    const firstLineBreak = text.indexOf("\n");
    text = firstLineBreak >= 0 ? text.slice(firstLineBreak + 1) : "";
  }
  return { text, stat };
}

export function parseRolloutTail(text) {
  let lifecycle = null;
  let lastRecordAt = null;
  let latestWorkAt = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const recordAt = Date.parse(record.timestamp);
      if (Number.isFinite(recordAt)) lastRecordAt = recordAt;

      if (record.type === "event_msg") {
        const eventType = record.payload?.type;
        if (["task_started", "task_complete", "turn_aborted"].includes(eventType)) {
          lifecycle = {
            type: eventType,
            at: recordAt,
            startedAt: record.payload?.started_at ? record.payload.started_at * 1000 : null,
            completedAt: record.payload?.completed_at ? record.payload.completed_at * 1000 : null,
            durationMs: record.payload?.duration_ms ?? null,
            reason: record.payload?.reason ?? null,
          };
          latestWorkAt = null;
        }
      }

      if (
        record.type === "response_item" &&
        ["reasoning", "custom_tool_call", "custom_tool_call_output"].includes(record.payload?.type)
      ) {
        latestWorkAt = recordAt;
      }
    } catch {
      // A writer may leave one incomplete final line while we are reading.
    }
  }

  return { lifecycle, lastRecordAt, latestWorkAt };
}

export function deriveStatus({ parsed, modifiedAt, isOpen, now = Date.now() }) {
  const recent = now - modifiedAt < 120_000;
  const { lifecycle, latestWorkAt } = parsed;

  if (lifecycle?.type === "task_started") {
    return {
      kind: isOpen || recent ? "running" : "disconnected",
      since: lifecycle.startedAt || lifecycle.at || modifiedAt,
      durationMs: null,
    };
  }

  const hasWorkAfterLifecycle = Boolean(
    lifecycle && latestWorkAt && latestWorkAt > (lifecycle.at || 0) + 500,
  );
  if (isOpen && recent && (!lifecycle || hasWorkAfterLifecycle)) {
    return { kind: "running", since: latestWorkAt || modifiedAt, durationMs: null };
  }

  if (lifecycle?.type === "turn_aborted") {
    return {
      kind: "interrupted",
      since: lifecycle.completedAt || lifecycle.at || modifiedAt,
      durationMs: lifecycle.durationMs,
    };
  }

  if (lifecycle?.type === "task_complete") {
    return {
      kind: "completed",
      since: lifecycle.completedAt || lifecycle.at || modifiedAt,
      durationMs: lifecycle.durationMs,
    };
  }

  return { kind: "unknown", since: modifiedAt, durationMs: null };
}

function getThreadStatus(thread) {
  const isOpen = existsSync(path.join(lockRoot, `${thread.id}.lock`));
  if (!thread.rollout_path || !existsSync(thread.rollout_path)) {
    return { kind: "unknown", since: thread.updated_at_ms, durationMs: null, isOpen };
  }

  try {
    const stat = statSync(thread.rollout_path);
    const signature = `${stat.size}:${stat.mtimeMs}:${isOpen}`;
    const cached = statusCache.get(thread.id);
    if (
      cached?.signature === signature &&
      !(cached.value.kind === "running" && !isOpen)
    ) return cached.value;

    const { text } = readTail(thread.rollout_path);
    const parsed = parseRolloutTail(text);
    const status = {
      ...deriveStatus({ parsed, modifiedAt: stat.mtimeMs, isOpen }),
      isOpen,
      lastActivityAt: parsed.lastRecordAt || stat.mtimeMs,
    };
    statusCache.set(thread.id, { signature, value: status });
    return status;
  } catch {
    return { kind: "unknown", since: thread.updated_at_ms, durationMs: null, isOpen };
  }
}

function sourceLabel(source) {
  if (source === "vscode") return "VS Code";
  if (source === "cli") return "Codex CLI";
  if (source === "app" || source === "codex_app") return "Codex App";
  if (typeof source === "string" && source.trim().startsWith("{")) return "Codex";
  return source || "Codex";
}

export function displayTitle(thread) {
  const fallback = thread.preview?.split("\n").find(Boolean) || "未命名 Chat";
  return (thread.name || thread.title || fallback).replace(/\s+/g, " ").trim().slice(0, 180);
}

function serializeThread(thread, indexedName) {
  const userFacingName = indexedName || thread.name || null;
  const namedThread = userFacingName ? { ...thread, name: userFacingName } : thread;
  return {
    id: thread.id,
    title: displayTitle(namedThread),
    customName: userFacingName,
    generatedTitle: thread.title || null,
    cwd: thread.cwd,
    source: sourceLabel(thread.source),
    updatedAt: thread.recency_at_ms || thread.updated_at_ms,
    createdAt: thread.created_at_ms,
    pinnedInCodex: Boolean(thread.is_pinned),
    status: getThreadStatus(thread),
  };
}

export function createSnapshot() {
  if (!existsSync(databasePath)) {
    return {
      ok: false,
      error: `未找到 Codex 状态库：${databasePath}`,
      tracked: [],
      candidates: [],
    };
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  let rows;
  try {
    rows = database.prepare(THREAD_QUERY).all(120);
  } finally {
    database.close();
  }

  const config = readConfig();
  const indexedNames = readThreadNameIndex();
  const byId = new Map(rows.map((thread) => [thread.id, thread]));
  const trackedRows = config.trackedThreadIds.map((id) => byId.get(id)).filter(Boolean);
  const trackedSet = new Set(config.trackedThreadIds);

  return {
    ok: true,
    readOnlyCodexDatabase: true,
    tracked: trackedRows.map((thread) => serializeThread(thread, indexedNames.get(thread.id))),
    missingTrackedIds: config.trackedThreadIds.filter((id) => !byId.has(id)),
    candidates: rows
      .filter((row) => !trackedSet.has(row.id))
      .map((thread) => serializeThread(thread, indexedNames.get(thread.id))),
  };
}

function originAllowed(origin) {
  return !origin || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin);
}

function commonHeaders(request) {
  const origin = request.headers.origin;
  return originAllowed(origin) && origin
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : {};
}

function sendJson(request, response, statusCode, body) {
  response.writeHead(statusCode, {
    ...commonHeaders(request),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16_384) reject(new Error("请求内容过大"));
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON 格式无效"));
      }
    });
    request.on("error", reject);
  });
}

function sendSnapshot(response) {
  response.write(`event: snapshot\ndata: ${JSON.stringify(createSnapshot())}\n\n`);
}

function broadcastSnapshot() {
  for (const response of clients) {
    try {
      sendSnapshot(response);
    } catch {
      clients.delete(response);
    }
  }
}

const defaultAppServerClient = new CodexAppServerClient({
  onNameUpdated: () => {
    // The notification is emitted after Codex accepts the name. Give its state
    // store one event-loop turn to become visible to our read-only connection.
    setTimeout(broadcastSnapshot, 25);
  },
});

async function waitForThreadName(threadId, name, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readThreadNameIndex().get(threadId) === name || findThread(threadId)?.name === name) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function handleMutation(request, response, action) {
  if (!originAllowed(request.headers.origin)) {
    sendJson(request, response, 403, { ok: false, error: "不允许的请求来源" });
    return;
  }

  try {
    const body = await readJson(request);
    if (!isValidThreadId(body.threadId)) {
      sendJson(request, response, 400, { ok: false, error: "threadId 无效" });
      return;
    }

    const config = readConfig();
    const ids = new Set(config.trackedThreadIds);
    if (action === "track") ids.add(body.threadId);
    if (action === "untrack") ids.delete(body.threadId);
    writeConfig({ trackedThreadIds: [...ids] });
    const snapshot = createSnapshot();
    sendJson(request, response, 200, snapshot);
    broadcastSnapshot();
  } catch (error) {
    sendJson(request, response, 400, { ok: false, error: error.message });
  }
}

async function handleOpenThread(request, response) {
  if (!originAllowed(request.headers.origin)) {
    sendJson(request, response, 403, { ok: false, error: "不允许的请求来源" });
    return;
  }

  try {
    const body = await readJson(request);
    if (!isValidThreadId(body.threadId)) {
      sendJson(request, response, 400, { ok: false, error: "threadId 无效" });
      return;
    }

    const thread = findThread(body.threadId);
    if (!thread) {
      sendJson(request, response, 404, { ok: false, error: "未找到对应的 Codex Chat" });
      return;
    }

    await openThreadInVSCode(thread);
    sendJson(request, response, 200, { ok: true, threadId: thread.id });
  } catch (error) {
    sendJson(request, response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "无法打开 Codex Chat",
    });
  }
}

async function handleRenameThread(request, response, {
  appServerClient,
  findThreadById,
  snapshotFactory,
  waitForName,
}) {
  if (!originAllowed(request.headers.origin)) {
    sendJson(request, response, 403, { ok: false, error: "不允许的请求来源" });
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    sendJson(request, response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : "请求无效",
    });
    return;
  }

  if (!isValidThreadId(body.threadId)) {
    sendJson(request, response, 400, { ok: false, error: "threadId 无效" });
    return;
  }

  let name;
  try {
    name = normalizeThreadName(body.name);
  } catch (error) {
    sendJson(request, response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : "会话名称无效",
    });
    return;
  }

  const thread = findThreadById(body.threadId);
  if (!thread) {
    sendJson(request, response, 404, { ok: false, error: "未找到对应的 Codex Chat" });
    return;
  }

  try {
    await appServerClient.setThreadName(thread.id, name);
    await waitForName(thread.id, name);
    const snapshot = snapshotFactory();
    sendJson(request, response, 200, snapshot);
    broadcastSnapshot();
  } catch (error) {
    sendJson(request, response, 502, {
      ok: false,
      error: `无法修改会话名称：${error instanceof Error ? error.message : "Codex App Server 不可用"}`,
    });
  }
}

export function createServer({
  appServerClient = defaultAppServerClient,
  findThreadById = findThread,
  snapshotFactory = createSnapshot,
  waitForName = waitForThreadName,
} = {}) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);

    if (request.method === "OPTIONS") {
      if (!originAllowed(request.headers.origin)) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(204, {
        ...commonHeaders(request),
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(request, response, 200, { ok: true, databaseFound: existsSync(databasePath) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      try {
        sendJson(request, response, 200, createSnapshot());
      } catch (error) {
        sendJson(request, response, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/pet") {
      sendJson(request, response, 200, readPetPackage());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      if (!originAllowed(request.headers.origin)) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, {
        ...commonHeaders(request),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      clients.add(response);
      sendSnapshot(response);
      request.on("close", () => clients.delete(response));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/track") {
      await handleMutation(request, response, "track");
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/untrack") {
      await handleMutation(request, response, "untrack");
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/open-thread") {
      await handleOpenThread(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/rename-thread") {
      await handleRenameThread(request, response, {
        appServerClient,
        findThreadById,
        snapshotFactory,
        waitForName,
      });
      return;
    }

    sendJson(request, response, 404, { ok: false, error: "Not found" });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Codex State bridge: http://${host}:${port}`);
    console.log(`Codex data: ${databasePath} (read-only)`);
  });

  const refreshTimer = setInterval(broadcastSnapshot, 2_000);
  const heartbeatTimer = setInterval(() => {
    for (const response of clients) response.write(": heartbeat\n\n");
  }, 15_000);

  const shutdown = () => {
    clearInterval(refreshTimer);
    clearInterval(heartbeatTimer);
    defaultAppServerClient.dispose();
    for (const response of clients) response.end();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
