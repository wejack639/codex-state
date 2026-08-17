import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexAppServerClient } from "../scripts/codex-app-server.mjs";

function createFakeAppServer() {
  const messages = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };

  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      messages.push(message);
      if (message.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "test" } })}\n`);
      }
      if (message.method === "thread/name/set") {
        child.stdout.write(`${JSON.stringify({
          method: "thread/name/updated",
          params: { threadId: message.params.threadId, name: message.params.name },
        })}\n`);
        child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      }
    }
  });

  return { child, messages };
}

test("App Server 客户端先握手，再调用正式会话改名接口", async () => {
  const fake = createFakeAppServer();
  const notifications = [];
  const client = new CodexAppServerClient({
    binaryPath: "/fake/codex",
    requestTimeoutMs: 500,
    spawnProcess: () => fake.child,
    onNameUpdated: (params) => notifications.push(params),
  });

  const threadId = "019ffec3-6de8-7601-a7f0-fbbf4ef8a9e0";
  await client.setThreadName(threadId, "新的会话名称");

  assert.deepEqual(fake.messages.map((message) => message.method), [
    "initialize",
    "initialized",
    "thread/name/set",
  ]);
  assert.deepEqual(fake.messages[2].params, { threadId, name: "新的会话名称" });
  assert.deepEqual(notifications, [{ threadId, name: "新的会话名称" }]);
  client.dispose();
});
