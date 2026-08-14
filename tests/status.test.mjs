import assert from "node:assert/strict";
import test from "node:test";
import {
  codexThreadDeepLink,
  deriveStatus,
  isValidThreadId,
  parseRolloutTail,
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
