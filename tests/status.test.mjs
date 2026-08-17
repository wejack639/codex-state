import assert from "node:assert/strict";
import test from "node:test";
import {
  codexThreadDeepLink,
  deriveStatus,
  displayTitle,
  isValidThreadId,
  normalizeThreadName,
  parseRolloutTail,
  parseThreadNameIndex,
} from "../scripts/bridge.mjs";

const line = (timestamp, type) => JSON.stringify({
  timestamp,
  type: "event_msg",
  payload: { type, started_at: 100, completed_at: 110, duration_ms: 10_000 },
});

test("最新 task_started 识别为运行中", () => {
  const parsed = parseRolloutTail([
    line("2026-08-14T00:00:00.000Z", "task_complete"),
    line("2026-08-14T00:01:00.000Z", "task_started"),
  ].join("\n"));
  const status = deriveStatus({ parsed, modifiedAt: Date.now(), isOpen: true });
  assert.equal(status.kind, "running");
});

test("task_complete 识别为已完成", () => {
  const parsed = parseRolloutTail(line("2026-08-14T00:00:00.000Z", "task_complete"));
  const status = deriveStatus({ parsed, modifiedAt: Date.now() - 60_000, isOpen: false });
  assert.equal(status.kind, "completed");
});

test("turn_aborted 识别为已中断", () => {
  const parsed = parseRolloutTail(line("2026-08-14T00:00:00.000Z", "turn_aborted"));
  const status = deriveStatus({ parsed, modifiedAt: Date.now() - 60_000, isOpen: false });
  assert.equal(status.kind, "interrupted");
});

test("无锁且长时间没更新的 task_started 识别为可能断联", () => {
  const parsed = parseRolloutTail(line("2026-08-14T00:00:00.000Z", "task_started"));
  const status = deriveStatus({ parsed, modifiedAt: Date.now() - 180_000, isOpen: false });
  assert.equal(status.kind, "disconnected");
});

test("Codex Chat 深链包含精确 thread id", () => {
  const threadId = "019ffec3-6de8-7601-a7f0-fbbf4ef8a9e0";
  assert.equal(isValidThreadId(threadId), true);
  assert.equal(
    codexThreadDeepLink(threadId),
    `vscode://openai.chatgpt/local/${threadId}`,
  );
  assert.throws(() => codexThreadDeepLink("not-a-thread"), /threadId 无效/);
});

test("自定义会话名称优先于自动标题", () => {
  assert.equal(displayTitle({ name: " 我的正式名称 ", title: "自动标题", preview: "首条消息" }), "我的正式名称");
  assert.equal(displayTitle({ name: null, title: "自动标题", preview: "首条消息" }), "自动标题");
  assert.equal(displayTitle({ name: null, title: "", preview: "首条消息\n下一行" }), "首条消息");
});

test("会话名称校验会去除首尾空格并拒绝非法输入", () => {
  assert.equal(normalizeThreadName("  新名称  "), "新名称");
  assert.throws(() => normalizeThreadName("   "), /不能为空/);
  assert.throws(() => normalizeThreadName("第一行\n第二行"), /控制字符/);
  assert.throws(() => normalizeThreadName("名".repeat(81)), /80 个字符/);
  assert.equal(normalizeThreadName("😀".repeat(80)), "😀".repeat(80));
});

test("会话名称索引使用同一 thread 的最后一次有效名称", () => {
  const threadId = "019ffec3-6de8-7601-a7f0-fbbf4ef8a9e0";
  const names = parseThreadNameIndex([
    JSON.stringify({ id: threadId, thread_name: "旧名称" }),
    JSON.stringify({ id: "not-a-thread", thread_name: "无效记录" }),
    JSON.stringify({ id: threadId, thread_name: "  VS Code 新名称  " }),
    "{ incomplete",
  ].join("\n"));

  assert.equal(names.get(threadId), "VS Code 新名称");
  assert.equal(names.has("not-a-thread"), false);
});
