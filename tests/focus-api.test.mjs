import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("重点关注通过真实配置持久化，与查看提醒、关注列表独立", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-state-focus-"));
  const previousCodexRoot = process.env.CODEX_STATE_CODEX_ROOT;
  const previousDataRoot = process.env.CODEX_STATE_DATA_ROOT;
  process.env.CODEX_STATE_CODEX_ROOT = directory;
  process.env.CODEX_STATE_DATA_ROOT = directory;
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (previousCodexRoot === undefined) delete process.env.CODEX_STATE_CODEX_ROOT;
    else process.env.CODEX_STATE_CODEX_ROOT = previousCodexRoot;
    if (previousDataRoot === undefined) delete process.env.CODEX_STATE_DATA_ROOT;
    else process.env.CODEX_STATE_DATA_ROOT = previousDataRoot;
    await rm(directory, { recursive: true, force: true });
  });
  const id = "019ffec3-6de8-7601-a7f0-fbbf4ef8a9e0";
  const otherId = "019ffeab-5b55-7b62-be1b-d14dd8b0ef7f";
  const now = Date.now();
  const configPath = path.join(directory, "config.json");
  const rolloutPath = path.join(directory, "thread.jsonl");
  await writeFile(rolloutPath, JSON.stringify({
    timestamp: new Date(now - 10_000).toISOString(),
    type: "event_msg",
    payload: { type: "task_complete", completed_at: (now - 10_000) / 1000 },
  }) + "\n");
  await writeFile(configPath, JSON.stringify({
    trackedThreadIds: [id], viewedAtByThreadId: { [id]: now - 20_000 },
  }));
  const database = new DatabaseSync(path.join(directory, "state_5.sqlite"));
  database.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, source TEXT,
    rollout_path TEXT, preview TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
    recency_at_ms INTEGER, is_pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
    agent_path TEXT
  )`);
  for (const threadId of [id, otherId]) {
    database.prepare(`INSERT INTO threads
      (id, title, cwd, source, rollout_path, created_at_ms, updated_at_ms, recency_at_ms)
      VALUES (?, ?, ?, 'vscode', ?, ?, ?, ?)`)
      .run(threadId, "测试会话", directory, rolloutPath, now, now, now);
  }
  database.close();
  const bridge = await import("../scripts/bridge.mjs?focus-test");
  const opened = [];
  const start = async (module = bridge) => {
    server = module.createServer({ openThread: async (thread) => opened.push(thread.id) });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  };
  await start();
  const post = async (action, threadId = id, origin = "http://localhost:3000") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ threadId }),
    });
    return { status: response.status, body: await response.json() };
  };
  const config = async () => JSON.parse(await readFile(configPath, "utf8"));

  await t.test("旧配置默认未标记，标记和重复标记不清除红色未查看提醒", async () => {
    assert.equal(bridge.createSnapshot().tracked[0].isFocused, false);
    for (let i = 0; i < 2; i++) {
      const result = await post("focus");
      assert.equal(result.status, 200);
      assert.equal(result.body.tracked[0].isFocused, true);
      assert.equal(result.body.tracked[0].unreadCompletion, true);
    }
    assert.deepEqual((await config()).focusedThreadIds, [id]);
    assert.equal((await config()).viewedAtByThreadId[id], now - 20_000);
  });

  await t.test("打开会话只清除红色提醒，金色星标保留", async () => {
    const result = await post("open-thread");
    assert.equal(result.status, 200);
    assert.deepEqual(opened, [id]);
    assert.equal(result.body.tracked[0].unreadCompletion, false);
    assert.equal(result.body.tracked[0].isFocused, true);
    assert.deepEqual((await config()).focusedThreadIds, [id]);
  });

  await t.test("重新加载服务仍保留星标，关注其他会话不覆盖星标", async () => {
    await new Promise((resolve) => server.close(resolve));
    const reloaded = await import("../scripts/bridge.mjs?focus-test-restarted");
    await start(reloaded);
    assert.equal(reloaded.createSnapshot().tracked[0].isFocused, true);
    const result = await post("track", otherId);
    assert.equal(result.status, 200);
    assert.equal(result.body.tracked.find((thread) => thread.id === id).isFocused, true);
    assert.deepEqual((await config()).focusedThreadIds, [id]);
  });

  await t.test("取消星标幂等，移除会话清除其星标且保留其他星标", async () => {
    const viewedAt = (await config()).viewedAtByThreadId[id];
    await post("unfocus");
    await post("unfocus");
    assert.deepEqual((await config()).focusedThreadIds, []);
    assert.equal((await config()).viewedAtByThreadId[id], viewedAt);
    await post("focus");
    await post("focus", otherId);
    await post("untrack", otherId);
    assert.deepEqual((await config()).focusedThreadIds, [id]);
    await post("track", otherId);
    assert.equal(bridge.createSnapshot().tracked.find((thread) => thread.id === otherId).isFocused, false);
  });

  await t.test("拒绝非法 ID、非本机来源和未添加会话，不修改配置", async () => {
    const before = await config();
    assert.equal((await post("focus", "invalid")).status, 400);
    assert.equal((await post("focus", id, "https://example.com")).status, 403);
    assert.equal((await post("focus", "00000000-0000-0000-0000-000000000000")).status, 404);
    assert.deepEqual(await config(), before);
  });
});
