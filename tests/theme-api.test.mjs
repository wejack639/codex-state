import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("主题在真实配置、会话操作及服务重启之间保持一致", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-state-theme-"));
  const previous = [process.env.CODEX_STATE_CODEX_ROOT, process.env.CODEX_STATE_DATA_ROOT];
  process.env.CODEX_STATE_CODEX_ROOT = directory;
  process.env.CODEX_STATE_DATA_ROOT = directory;
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    for (const [index, key] of ["CODEX_STATE_CODEX_ROOT", "CODEX_STATE_DATA_ROOT"].entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
    await rm(directory, { recursive: true, force: true });
  });
  const id = "019ffec3-6de8-7601-a7f0-fbbf4ef8a9e0";
  const otherId = "019ffeab-5b55-7b62-be1b-d14dd8b0ef7f";
  const now = Date.now();
  const configPath = path.join(directory, "config.json");
  const rolloutPath = path.join(directory, "thread.jsonl");
  await writeFile(rolloutPath, JSON.stringify({
    timestamp: new Date(now - 10_000).toISOString(), type: "event_msg",
    payload: { type: "task_complete", completed_at: (now - 10_000) / 1000 },
  }) + "\n");
  const legacyConfig = {
    trackedThreadIds: [id], focusedThreadIds: [id], viewedAtByThreadId: { [id]: now - 20_000 },
  };
  await writeFile(configPath, JSON.stringify(legacyConfig));
  const db = new DatabaseSync(path.join(directory, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, source TEXT, rollout_path TEXT,
    preview TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, recency_at_ms INTEGER,
    is_pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, agent_path TEXT
  )`);
  for (const threadId of [id, otherId]) {
    db.prepare(`INSERT INTO threads (id, title, cwd, source, rollout_path, created_at_ms, updated_at_ms, recency_at_ms)
      VALUES (?, '主题测试会话', ?, 'vscode', ?, ?, ?, ?)`)
      .run(threadId, directory, rolloutPath, now, now, now);
  }
  db.close();
  let bridge = await import("../scripts/bridge.mjs?theme-test");
  const start = async () => {
    server = bridge.createServer({ openThread: async () => {} });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  };
  await start();
  const url = (route) => `http://127.0.0.1:${server.address().port}/api/${route}`;
  const post = async (route, body, origin = "http://localhost:3000") => {
    const response = await fetch(url(route), {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const config = async () => JSON.parse(await readFile(configPath, "utf8"));

  await t.test("旧配置保持深色，所有关注和已查看信息不丢失", async () => {
    const snapshot = bridge.createSnapshot();
    assert.equal(snapshot.theme, "midnight");
    assert.equal(snapshot.tracked[0].isFocused, true);
    assert.equal(snapshot.tracked[0].unreadCompletion, true);
    assert.deepEqual(await config(), { ...legacyConfig, theme: "midnight" });
  });

  await t.test("七种主题均可保存，响应与持久化结果一致", async () => {
    for (const theme of ["glacier", "sakura", "mint", "lavender", "peach", "cloud", "midnight"]) {
      const result = await post("theme", { theme });
      assert.equal(result.status, 200);
      assert.equal(result.body.theme, theme);
      assert.deepEqual(await config(), { ...legacyConfig, theme });
    }
  });

  await t.test("主题通过现有事件流同步", async () => {
    const controller = new AbortController();
    const response = await fetch(url("events"), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]) });
    const reader = response.body.getReader();
    try {
      await reader.read();
      await post("theme", { theme: "sakura" });
      const { value } = await reader.read();
      assert.match(new TextDecoder().decode(value), /"theme":"sakura"/);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });

  await t.test("添加、标星、取消标星、打开及移除不会覆盖主题", async () => {
    for (const [action, threadId] of [
      ["track", otherId], ["focus", otherId], ["unfocus", otherId],
      ["open-thread", id], ["untrack", otherId],
    ]) {
      const result = await post(action, { threadId });
      assert.equal(result.status, 200, action);
      assert.equal(result.body.theme, "sakura", action);
      assert.equal((await config()).theme, "sakura", action);
    }
  });

  await t.test("拒绝无效名称与非本机写入，不改变当前合法设置", async () => {
    const before = await config();
    for (const theme of ["custom", "", null, 1, {}, "GLACIER"]) {
      assert.equal((await post("theme", { theme })).status, 400);
      assert.deepEqual(await config(), before);
    }
    assert.equal((await post("theme", { theme: "mint" }, "https://example.com")).status, 403);
    assert.deepEqual(await config(), before);
  });

  await t.test("配置整理及重新加载服务后仍保留已选主题", async () => {
    const current = await config();
    await writeFile(configPath, JSON.stringify({ ...current, viewedAtByThreadId: { ...current.viewedAtByThreadId, [otherId]: now } }));
    assert.equal(bridge.createSnapshot().theme, "sakura");
    assert.deepEqual(await config(), current);
    await new Promise((resolve) => server.close(resolve));
    bridge = await import("../scripts/bridge.mjs?theme-test-restarted");
    await start();
    assert.equal((await fetch(url("state")).then((r) => r.json())).theme, "sakura");
  });
});
