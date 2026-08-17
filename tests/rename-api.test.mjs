import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../scripts/bridge.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("重命名 API 调用 App Server 并返回最新快照", async () => {
  const calls = [];
  const threadId = "019ffec3-6de8-7601-a7f0-fbbf4ef8a9e0";
  const snapshot = { ok: true, tracked: [], candidates: [] };
  const server = createServer({
    appServerClient: {
      async setThreadName(id, name) {
        calls.push({ id, name });
      },
    },
    findThreadById: (id) => id === threadId ? { id } : null,
    snapshotFactory: () => snapshot,
    waitForName: async () => true,
  });

  try {
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/rename-thread`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({ threadId, name: "  正式名称  " }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.deepEqual(calls, [{ id: threadId, name: "正式名称" }]);
  } finally {
    await close(server);
  }
});
