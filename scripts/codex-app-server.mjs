import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

export class CodexAppServerTransportError extends Error {}

export class CodexAppServerRpcError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function isExecutable(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function extensionPlatformDirectory() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "macos-aarch64" : "macos-x86_64";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
  }
  return null;
}

export function discoverCodexBinary({
  environment = process.env,
  homeDirectory = os.homedir(),
} = {}) {
  const explicitPath = environment.CODEX_STATE_CODEX_BIN;
  if (explicitPath) {
    if (!isExecutable(explicitPath)) {
      throw new Error(`CODEX_STATE_CODEX_BIN 不可执行：${explicitPath}`);
    }
    return explicitPath;
  }

  const platformDirectory = extensionPlatformDirectory();
  const extensionRoots = [
    path.join(homeDirectory, ".vscode", "extensions"),
    path.join(homeDirectory, ".vscode-insiders", "extensions"),
    path.join(homeDirectory, ".cursor", "extensions"),
    path.join(homeDirectory, ".windsurf", "extensions"),
  ];

  if (platformDirectory) {
    for (const extensionRoot of extensionRoots) {
      if (!existsSync(extensionRoot)) continue;
      let extensionNames;
      try {
        extensionNames = readdirSync(extensionRoot)
          .filter((name) => name.startsWith("openai.chatgpt-"))
          .sort((first, second) => second.localeCompare(first, undefined, { numeric: true }));
      } catch {
        continue;
      }
      for (const extensionName of extensionNames) {
        const candidate = path.join(
          extensionRoot,
          extensionName,
          "bin",
          platformDirectory,
          process.platform === "win32" ? "codex.exe" : "codex",
        );
        if (isExecutable(candidate)) return candidate;
      }
    }
  }

  for (const candidate of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    if (isExecutable(candidate)) return candidate;
  }

  // Retain PATH lookup for terminal/browser development on other platforms.
  return "codex";
}

export class CodexAppServerClient {
  constructor({
    binaryPath,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onNameUpdated = () => {},
    spawnProcess = spawn,
  } = {}) {
    this.binaryPath = binaryPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onNameUpdated = onNameUpdated;
    this.spawnProcess = spawnProcess;
    this.process = null;
    this.lineReader = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.startPromise = null;
    this.initialized = false;
    this.disposed = false;
  }

  async setThreadName(threadId, name) {
    try {
      return await this.request("thread/name/set", { threadId, name });
    } catch (error) {
      if (error instanceof CodexAppServerRpcError || this.disposed) throw error;
      this.stopProcess();
      return this.request("thread/name/set", { threadId, name });
    }
  }

  async request(method, params) {
    await this.ensureStarted();
    return this.requestRaw(method, params);
  }

  async ensureStarted() {
    if (this.disposed) throw new CodexAppServerTransportError("Codex App Server 客户端已关闭");
    if (this.process && this.initialized) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.start()
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  async start() {
    const binaryPath = this.binaryPath || discoverCodexBinary();
    const child = this.spawnProcess(binaryPath, ["app-server"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    this.initialized = false;

    this.lineReader = readline.createInterface({ input: child.stdout });
    this.lineReader.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) console.error(`[Codex App Server] ${message}`);
    });
    child.stdin.on("error", (error) => this.handleProcessEnd(child, error));
    child.once("error", (error) => this.handleProcessEnd(child, error));
    child.once("exit", (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.handleProcessEnd(child, new Error(`Codex App Server 已退出（${suffix}）`));
    });

    try {
      await this.requestRaw("initialize", {
        clientInfo: {
          name: "codex_state",
          title: "Codex State",
          version: "0.1.0",
        },
      });
      this.writeMessage({ method: "initialized", params: {} });
      this.initialized = true;
    } catch (error) {
      this.stopProcess();
      throw error;
    }
  }

  requestRaw(method, params) {
    const child = this.process;
    if (!child?.stdin?.writable) {
      return Promise.reject(new CodexAppServerTransportError("Codex App Server 未连接"));
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerTransportError(`Codex App Server 请求超时：${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });

      try {
        this.writeMessage({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CodexAppServerTransportError(
          error instanceof Error ? error.message : "无法发送 Codex App Server 请求",
        ));
      }
    });
  }

  writeMessage(message) {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) throw new Error("Codex App Server 输入流不可用");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new CodexAppServerRpcError(
          message.error.message || `${pending.method} 调用失败`,
          message.error.code,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "thread/name/updated") {
      this.onNameUpdated(message.params || {});
    }
  }

  handleProcessEnd(child, error) {
    if (this.process !== child) return;
    this.process = null;
    this.initialized = false;
    this.lineReader?.close();
    this.lineReader = null;
    const transportError = new CodexAppServerTransportError(error.message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(transportError);
    }
    this.pending.clear();
  }

  stopProcess() {
    const child = this.process;
    if (!child) return;
    this.process = null;
    this.initialized = false;
    this.lineReader?.close();
    this.lineReader = null;
    if (!child.killed) child.kill("SIGTERM");
    const error = new CodexAppServerTransportError("Codex App Server 连接已重置");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  dispose() {
    this.disposed = true;
    this.stopProcess();
  }
}
