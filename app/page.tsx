"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { CodexPetSprite, type CodexPetState } from "./pet-sprite";

type StatusKind = "running" | "completed" | "interrupted" | "disconnected" | "unknown";

type Thread = {
  id: string;
  title: string;
  customName: string | null;
  generatedTitle: string | null;
  cwd: string;
  source: string;
  updatedAt: number;
  createdAt: number;
  pinnedInCodex: boolean;
  status: {
    kind: StatusKind;
    since: number;
    durationMs: number | null;
    isOpen: boolean;
    lastActivityAt: number;
  };
};

type Snapshot = {
  ok: boolean;
  error?: string;
  readOnlyCodexDatabase?: boolean;
  tracked: Thread[];
  candidates: Thread[];
  missingTrackedIds?: string[];
};

const bridgeBase = "http://127.0.0.1:43991";
const emptySnapshot: Snapshot = { ok: false, tracked: [], candidates: [] };
const subscribeToLocation = () => () => {};
const getCompactSnapshot = () => new URLSearchParams(window.location.search).get("compact") === "1";
const getPetSnapshot = () => new URLSearchParams(window.location.search).get("pet") === "1";

const statusMeta: Record<StatusKind, { label: string; detail: string }> = {
  running: { label: "运行中", detail: "Codex 正在处理这个 Chat" },
  completed: { label: "已完成", detail: "上一轮已完成，等待新指令" },
  interrupted: { label: "已中断", detail: "上一轮任务被中断" },
  disconnected: { label: "可能断联", detail: "任务未正常结束，当前没有会话连接" },
  unknown: { label: "未知", detail: "暂时无法确定最新状态" },
};

function shortWorkspace(cwd: string) {
  const pieces = cwd.split("/").filter(Boolean);
  return pieces.slice(-3).join(" / ") || cwd;
}

function workspaceName(cwd: string) {
  return cwd.split("/").filter(Boolean).at(-1) || cwd;
}

function relativeTime(timestamp: number, now: number) {
  if (!timestamp) return "时间未知";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

function elapsedTime(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function postPanelMessage(message: Record<string, unknown>) {
  const panel = (window as Window & {
    webkit?: { messageHandlers?: { panel?: { postMessage: (value: unknown) => void } } };
  }).webkit?.messageHandlers?.panel;
  panel?.postMessage(message);
}

type ThreadNameEditorProps = {
  thread: Thread;
  saving: boolean;
  variant: "pet" | "card";
  renameThread: (threadId: string, name: string) => Promise<void>;
  onEditingChange?: (editing: boolean) => void;
};

function ThreadNameEditor({
  thread,
  saving,
  variant,
  renameThread,
  onEditingChange,
}: ThreadNameEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const changeEditing = useCallback((next: boolean) => {
    setEditing(next);
    onEditingChange?.(next);
  }, [onEditingChange]);

  const beginEditing = useCallback(() => {
    setDraft(thread.title);
    setError(null);
    changeEditing(true);
  }, [changeEditing, thread.title]);

  const cancelEditing = useCallback(() => {
    if (saving) return;
    setDraft(thread.title);
    setError(null);
    changeEditing(false);
  }, [changeEditing, saving, thread.title]);

  const saveName = useCallback(async () => {
    if (saving) return;
    setError(null);
    try {
      await renameThread(thread.id, draft);
      changeEditing(false);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "修改名称失败");
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [changeEditing, draft, renameThread, saving, thread.id]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className={`threadNameDisplay ${variant}`}
        aria-label={`修改会话名称：${thread.title}`}
        title="点击修改会话名称"
        onClick={beginEditing}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span>{thread.title}</span>
        <span className="renameGlyph" aria-hidden="true">✎</span>
      </button>
    );
  }

  return (
    <div
      className={`threadNameEditor ${variant}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="threadNameInputRow">
        <input
          ref={inputRef}
          value={draft}
          aria-label="新的会话名称"
          disabled={saving}
          maxLength={80}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveName();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEditing();
            }
          }}
        />
        <button
          type="button"
          className="threadNameSave"
          aria-label="保存会话名称"
          title="保存"
          disabled={saving}
          onClick={() => void saveName()}
        >{saving ? "…" : "✓"}</button>
        <button
          type="button"
          className="threadNameCancel"
          aria-label="取消修改"
          title="取消"
          disabled={saving}
          onClick={cancelEditing}
        >×</button>
      </div>
      {error && <span className="threadNameError" role="alert">{error}</span>}
    </div>
  );
}

type PetViewProps = {
  snapshot: Snapshot;
  connected: boolean;
  pickerOpen: boolean;
  query: string;
  busyId: string | null;
  openingId: string | null;
  renamingId: string | null;
  actionError: string | null;
  now: number;
  workspaceGroups: Array<[string, Thread[]]>;
  filteredCandidates: Thread[];
  runningCount: number;
  setPickerOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  mutateTracking: (threadId: string, action: "track" | "untrack") => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  renameThread: (threadId: string, name: string) => Promise<void>;
};

function PetView({
  snapshot,
  connected,
  pickerOpen,
  query,
  busyId,
  openingId,
  renamingId,
  actionError,
  now,
  workspaceGroups,
  filteredCandidates,
  runningCount,
  setPickerOpen,
  setQuery,
  mutateTracking,
  openThread,
  renameThread,
}: PetViewProps) {
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragPetState, setDragPetState] = useState<CodexPetState | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const collapseTimer = useRef<number | null>(null);
  const expandSuppressedUntil = useRef(0);
  const draggingRef = useRef(false);
  const dragPointerId = useRef<number | null>(null);
  const dragScreenX = useRef<number | null>(null);
  const editingThreadIdRef = useRef<string | null>(null);
  const hoveredRef = useRef(false);
  const trackedCount = snapshot.tracked.length;
  const hasDisconnectedThread = snapshot.tracked.some((thread) => thread.status.kind === "disconnected");
  const petState: CodexPetState = !connected || hasDisconnectedThread
    ? "failed"
    : runningCount > 0
      ? "running"
      : "idle";
  const trackedContentHeight = Math.max(
    270,
    110 + workspaceGroups.length * 66 + trackedCount * 58
      + (actionError || snapshot.error ? 38 : 0)
      + (editingThreadId ? 34 : 0),
  );
  const availablePanelHeight = typeof window === "undefined"
    ? 860
    : Math.max(270, window.screen.availHeight - 28);
  const availablePanelWidth = typeof window === "undefined"
    ? 430
    : Math.max(430, window.screen.availWidth - 28);
  const workspaceColumns = pickerOpen
    ? 1
    : Math.max(1, Math.ceil(trackedContentHeight / availablePanelHeight));
  const expandedHeight = pickerOpen
    ? Math.min(590, availablePanelHeight)
    : Math.min(trackedContentHeight, availablePanelHeight);
  const expandedWidth = Math.min(430 * workspaceColumns, availablePanelWidth);

  const cancelCollapse = useCallback(() => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
  }, []);

  const collapsePanel = useCallback((suppressExpansionMs = 700) => {
    cancelCollapse();
    expandSuppressedUntil.current = Date.now() + suppressExpansionMs;
    draggingRef.current = false;
    dragPointerId.current = null;
    dragScreenX.current = null;
    setDragging(false);
    setDragPetState(null);
    editingThreadIdRef.current = null;
    setEditingThreadId(null);
    setExpanded(false);
    setPickerOpen(false);
    postPanelMessage({
      type: "resize",
      expanded: false,
      suppressExpansionMs,
    });
  }, [cancelCollapse, setPickerOpen]);

  const expandPanel = useCallback(() => {
    if (Date.now() < expandSuppressedUntil.current) return;
    cancelCollapse();
    setExpanded(true);
    postPanelMessage({ type: "resize", expanded: true, width: expandedWidth, height: expandedHeight });
  }, [cancelCollapse, expandedHeight, expandedWidth]);

  const scheduleCollapse = useCallback(() => {
    if (draggingRef.current || editingThreadIdRef.current) return;
    cancelCollapse();
    collapseTimer.current = window.setTimeout(collapsePanel, 320);
  }, [cancelCollapse, collapsePanel]);

  const setThreadEditing = useCallback((threadId: string, editing: boolean) => {
    cancelCollapse();
    editingThreadIdRef.current = editing ? threadId : null;
    setEditingThreadId(editing ? threadId : null);
    if (!editing && !hoveredRef.current) scheduleCollapse();
  }, [cancelCollapse, scheduleCollapse]);

  const handleMouseEnter = useCallback(() => {
    hoveredRef.current = true;
    expandPanel();
  }, [expandPanel]);

  const handleMouseLeave = useCallback(() => {
    hoveredRef.current = false;
    scheduleCollapse();
  }, [scheduleCollapse]);

  const openThreadAndCollapse = useCallback((threadId: string) => {
    // 切换到 VS Code 后 WebView 不一定还能收到 mouseleave。立即收回，并在跳转完成后再兜底收回一次。
    collapsePanel(1800);
    void openThread(threadId).finally(() => collapsePanel(1200));
  }, [collapsePanel, openThread]);

  const beginPanelDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    cancelCollapse();
    draggingRef.current = true;
    dragPointerId.current = event.pointerId;
    dragScreenX.current = event.screenX;
    setDragging(true);
    setDragPetState("jumping");
    event.currentTarget.setPointerCapture(event.pointerId);
    postPanelMessage({ type: "dragStart", screenX: event.screenX, screenY: event.screenY });
    event.preventDefault();
  }, [cancelCollapse]);

  const movePanelDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!draggingRef.current || dragPointerId.current !== event.pointerId) return;
    const previousScreenX = dragScreenX.current ?? event.screenX;
    const deltaX = event.screenX - previousScreenX;
    if (deltaX >= 4) {
      dragScreenX.current = event.screenX;
      setDragPetState("running-right");
    } else if (deltaX <= -4) {
      dragScreenX.current = event.screenX;
      setDragPetState("running-left");
    }
    postPanelMessage({ type: "dragMove", screenX: event.screenX, screenY: event.screenY });
  }, []);

  const endPanelDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!draggingRef.current || dragPointerId.current !== event.pointerId) return;
    draggingRef.current = false;
    dragPointerId.current = null;
    dragScreenX.current = null;
    setDragging(false);
    setDragPetState(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    postPanelMessage({ type: "dragEnd" });
  }, []);

  useEffect(() => {
    document.documentElement.classList.add("petDocument");
    document.body.classList.add("petDocument");
    postPanelMessage({ type: "resize", expanded: false });
    return () => {
      document.documentElement.classList.remove("petDocument");
      document.body.classList.remove("petDocument");
      cancelCollapse();
    };
  }, [cancelCollapse]);

  useEffect(() => {
    if (expanded) {
      postPanelMessage({ type: "resize", expanded: true, width: expandedWidth, height: expandedHeight });
    }
  }, [expanded, expandedHeight, expandedWidth]);

  return (
    <main
      className={`petShell ${expanded ? "expanded" : "collapsed"} ${dragging ? "dragging" : ""}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <header
        className="petBar"
        title="按住这里拖动窗口"
        onPointerDown={beginPanelDrag}
        onPointerMove={movePanelDrag}
        onPointerUp={endPanelDrag}
        onPointerCancel={endPanelDrag}
      >
        <div className={`petOrb ${!connected || hasDisconnectedThread ? "offline" : runningCount > 0 ? "running" : "idle"}`}>
          <CodexPetSprite state={petState} transientState={dragging ? dragPetState : null} />
        </div>
      </header>

      {expanded && (
        <section className="petDrawer">
          <div className="petDrawerHead">
            <div>
              <strong>{pickerOpen ? "添加关注" : "关注中的 Chat"}</strong>
              <span>{pickerOpen ? "本机最近会话" : `${workspaceGroups.length} 个工作目录`}</span>
            </div>
            <div className="petHeadActions">
              <button
                type="button"
                className="petCollapse"
                aria-label="收回面板"
                title="收回面板"
                onClick={() => collapsePanel(900)}
              >收回</button>
              {pickerOpen ? (
                <button type="button" onClick={() => setPickerOpen(false)}>返回</button>
              ) : (
                <button type="button" onClick={() => setPickerOpen(true)}>＋ 添加</button>
              )}
            </div>
          </div>

          {(actionError || snapshot.error) && (
            <div className="petError" role="alert">{actionError || snapshot.error}</div>
          )}

          {pickerOpen ? (
            <div className="petPicker">
              <label className="petSearch">
                <span aria-hidden="true">⌕</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索名称或工作目录"
                />
              </label>
              <div className="petCandidateList">
                {filteredCandidates.length === 0 ? (
                  <p className="petEmpty">没有可添加的 Chat</p>
                ) : filteredCandidates.map((thread) => (
                  <article className="petCandidate" key={thread.id}>
                    <span className={`stateDot ${thread.status.kind}`} />
                    <div>
                      <strong>{thread.title}</strong>
                      <span>{thread.cwd}</span>
                    </div>
                    <button
                      type="button"
                      disabled={busyId === thread.id}
                      onClick={() => mutateTracking(thread.id, "track")}
                    >{busyId === thread.id ? "…" : "添加"}</button>
                  </article>
                ))}
              </div>
            </div>
          ) : workspaceGroups.length === 0 ? (
            <button type="button" className="petEmpty petEmptyButton" onClick={() => setPickerOpen(true)}>
              还没有关注 Chat，点这里添加
            </button>
          ) : (
            <div
              className={`petWorkspaceList ${workspaceColumns > 1 ? "multiColumn" : ""}`}
              style={{ columnCount: workspaceColumns }}
            >
              {workspaceGroups.map(([cwd, threads]) => (
                <section className="petWorkspace" key={cwd}>
                  <div className="petWorkspaceHead">
                    <div>
                      <strong>{workspaceName(cwd)}</strong>
                      <code title={cwd}>{cwd}</code>
                    </div>
                    <span>{threads.length}</span>
                  </div>
                  <div className="petThreads">
                    {threads.map((thread) => {
                      const meta = statusMeta[thread.status.kind];
                      return (
                        <article className="petThread" key={thread.id}>
                          <span className={`stateDot ${thread.status.kind}`} />
                          <div className="petThreadMain">
                            <ThreadNameEditor
                              thread={thread}
                              variant="pet"
                              saving={renamingId === thread.id}
                              renameThread={renameThread}
                              onEditingChange={(editing) => setThreadEditing(thread.id, editing)}
                            />
                            <span className={thread.status.kind}>
                              {meta.label} · {thread.status.kind === "running"
                                ? elapsedTime(thread.status.since, now)
                                : relativeTime(thread.status.lastActivityAt || thread.updatedAt, now)}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="petOpen"
                            disabled={openingId === thread.id || editingThreadId === thread.id || renamingId === thread.id}
                            onClick={() => openThreadAndCollapse(thread.id)}
                          >{openingId === thread.id ? "…" : "打开"}</button>
                          <button
                            type="button"
                            className="petRemove"
                            disabled={busyId === thread.id || editingThreadId === thread.id || renamingId === thread.id}
                            aria-label={`移除 ${thread.title}`}
                            title="仅取消关注"
                            onClick={() => mutateTracking(thread.id, "untrack")}
                          >×</button>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
      )}
    </main>
  );
}

export default function Home() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [connected, setConnected] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const previousStatusKinds = useRef<Map<string, StatusKind>>(new Map());
  const compact = useSyncExternalStore(subscribeToLocation, getCompactSnapshot, () => false);
  const pet = useSyncExternalStore(subscribeToLocation, getPetSnapshot, () => false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${bridgeBase}/api/state`)
      .then((response) => response.json())
      .then((data: Snapshot) => {
        if (!cancelled) {
          setSnapshot(data);
          setConnected(true);
        }
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });

    const events = new EventSource(`${bridgeBase}/api/events`);
    events.addEventListener("snapshot", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as Snapshot;
      setSnapshot(data);
      setConnected(true);
    });
    events.onerror = () => setConnected(false);

    return () => {
      cancelled = true;
      events.close();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const current = new Map<string, StatusKind>();
    for (const thread of snapshot.tracked) {
      const nextKind = thread.status.kind;
      const previousKind = previousStatusKinds.current.get(thread.id);
      current.set(thread.id, nextKind);
      if (
        previousKind === "running" &&
        ["completed", "interrupted", "disconnected"].includes(nextKind)
      ) {
        postPanelMessage({
          type: "notify",
          threadId: thread.id,
          title: thread.title,
          cwd: thread.cwd,
          status: nextKind,
        });
      }
    }
    previousStatusKinds.current = current;
  }, [snapshot.tracked]);

  const mutateTracking = useCallback(async (threadId: string, action: "track" | "untrack") => {
    setBusyId(threadId);
    setActionError(null);
    try {
      const response = await fetch(`${bridgeBase}/api/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId }),
      });
      const data = await response.json() as Snapshot;
      if (!response.ok || !data.ok) throw new Error(data.error || "操作失败");
      setSnapshot(data);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  }, []);

  const openThread = useCallback(async (threadId: string) => {
    setOpeningId(threadId);
    setActionError(null);
    try {
      const response = await fetch(`${bridgeBase}/api/open-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId }),
      });
      const data = await response.json() as { ok: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || "无法恢复 Chat");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "无法恢复 Chat");
    } finally {
      setOpeningId(null);
    }
  }, []);

  const renameThread = useCallback(async (threadId: string, name: string) => {
    setRenamingId(threadId);
    setActionError(null);
    try {
      const response = await fetch(`${bridgeBase}/api/rename-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, name }),
      });
      const data = await response.json() as Snapshot;
      if (!response.ok || !data.ok) throw new Error(data.error || "修改名称失败");
      setSnapshot(data);
    } finally {
      setRenamingId(null);
    }
  }, []);

  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, Thread[]>();
    for (const thread of snapshot.tracked) {
      const list = groups.get(thread.cwd) || [];
      list.push(thread);
      groups.set(thread.cwd, list);
    }
    return [...groups.entries()];
  }, [snapshot.tracked]);

  const filteredCandidates = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return snapshot.candidates;
    return snapshot.candidates.filter((thread) =>
      `${thread.title} ${thread.cwd} ${thread.source}`.toLocaleLowerCase().includes(needle),
    );
  }, [query, snapshot.candidates]);

  const runningCount = snapshot.tracked.filter((thread) => thread.status.kind === "running").length;

  if (pet) {
    return (
      <PetView
        snapshot={snapshot}
        connected={connected}
        pickerOpen={pickerOpen}
        query={query}
        busyId={busyId}
        openingId={openingId}
        renamingId={renamingId}
        actionError={actionError}
        now={now}
        workspaceGroups={workspaceGroups}
        filteredCandidates={filteredCandidates}
        runningCount={runningCount}
        setPickerOpen={setPickerOpen}
        setQuery={setQuery}
        mutateTracking={mutateTracking}
        openThread={openThread}
        renameThread={renameThread}
      />
    );
  }

  return (
    <main className={`shell ${compact ? "compact" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brandMark" aria-hidden="true">C</span>
          <div>
            <strong>Codex State</strong>
            <span>本机工作台</span>
          </div>
        </div>
        <div className={`livePill ${connected ? "online" : "offline"}`}>
          <span />{connected ? "实时连接" : "本机桥接未连接"}
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">MISSION CONTROL</p>
          <h1>你的 Codex 会话，<br />一眼尽览。</h1>
          <p className="lede">按工作空间集中观测 VS Code 中的多个 Chat，状态直接来自本机 Codex，不再依赖桌面端同步。</p>
        </div>
        <div className="metrics" aria-label="会话摘要">
          <div><strong>{String(snapshot.tracked.length).padStart(2, "0")}</strong><span>已关注</span></div>
          <div><strong className="green">{String(runningCount).padStart(2, "0")}</strong><span>运行中</span></div>
          <div><strong>{String(workspaceGroups.length).padStart(2, "0")}</strong><span>工作空间</span></div>
        </div>
      </section>

      {!connected && (
        <div className="notice" role="status">
          <strong>面板尚未连接本机状态桥。</strong>
          <span>请使用 <code>npm run dashboard</code> 启动完整服务。</span>
        </div>
      )}

      {(snapshot.error || actionError) && (
        <div className="errorNotice" role="alert">{actionError || snapshot.error}</div>
      )}

      <section className="board">
        <div className="sectionHead">
          <div>
            <p className="eyebrow">ACTIVE BOARD</p>
            <h2>已关注的 Chat</h2>
          </div>
          <button type="button" className="addButton" onClick={() => setPickerOpen(true)}>
            <span aria-hidden="true">+</span>添加 Chat
          </button>
        </div>

        {workspaceGroups.length === 0 ? (
          <div className="emptyState">
            <span className="emptyGlyph" aria-hidden="true">⌘</span>
            <h3>还没有关注 Chat</h3>
            <p>从本机 Codex 会话列表中添加，它们将按工作空间自动分组。</p>
            <button type="button" className="emptyAction" onClick={() => setPickerOpen(true)}>选择第一个 Chat</button>
          </div>
        ) : (
          <div className="workspaceList">
            {workspaceGroups.map(([cwd, threads]) => (
              <section className="workspaceGroup" key={cwd}>
                <div className="workspaceHead">
                  <div className="folderMark" aria-hidden="true">W</div>
                  <div>
                    <h3>{workspaceName(cwd)}</h3>
                    <p>{cwd}</p>
                  </div>
                  <span>{threads.length} Chat</span>
                </div>
                <div className="cards">
                  {threads.map((thread) => {
                    const meta = statusMeta[thread.status.kind];
                    const detail = thread.status.kind === "running"
                      ? `${meta.detail} · ${elapsedTime(thread.status.since, now)}`
                      : meta.detail;
                    return (
                      <article className={`chatCard ${thread.status.kind}`} key={thread.id}>
                        <div className="cardTop">
                          <span className={`stateDot ${thread.status.kind}`} />
                          <span className={`stateLabel ${thread.status.kind}`}>{meta.label}</span>
                          {thread.status.isOpen && <span className="openLabel">已打开</span>}
                          <button
                            className="removeButton"
                            type="button"
                            disabled={busyId === thread.id || renamingId === thread.id}
                            aria-label={`从面板移除 ${thread.title}`}
                            title="仅从面板移除，不删除真实 Chat"
                            onClick={() => mutateTracking(thread.id, "untrack")}
                          >×</button>
                        </div>
                        <p className="path">{thread.source} · {shortWorkspace(thread.cwd)}</p>
                        <ThreadNameEditor
                          thread={thread}
                          variant="card"
                          saving={renamingId === thread.id}
                          renameThread={renameThread}
                        />
                        <p className="detail">{detail}</p>
                        <footer>
                          <span>{relativeTime(thread.status.lastActivityAt || thread.updatedAt, now)}</span>
                          <button
                            type="button"
                            className="openThreadButton"
                            disabled={openingId === thread.id || renamingId === thread.id}
                            onClick={() => openThread(thread.id)}
                          >{openingId === thread.id ? "正在恢复…" : "恢复此 Chat ↗"}</button>
                        </footer>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </section>

      <footer className="privacyNote">
        <span className="privacyDot" /> Codex 数据库只读 · 名称通过官方接口保存 · 移除关注不会删除 Chat
      </footer>

      {pickerOpen && (
        <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setPickerOpen(false);
        }}>
          <section className="picker" role="dialog" aria-modal="true" aria-labelledby="picker-title">
            <div className="pickerHead">
              <div>
                <p className="eyebrow">LOCAL THREADS</p>
                <h2 id="picker-title">添加 Codex Chat</h2>
                <p>从本机最近的顶层会话中选择。</p>
              </div>
              <button type="button" className="closeButton" aria-label="关闭" onClick={() => setPickerOpen(false)}>×</button>
            </div>
            <label className="searchBox">
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 Chat 名称或工作空间…"
              />
            </label>
            <div className="candidateList">
              {filteredCandidates.length === 0 ? (
                <p className="noResults">没有匹配的 Chat</p>
              ) : filteredCandidates.map((thread) => (
                <article className="candidate" key={thread.id}>
                  <span className={`stateDot ${thread.status.kind}`} />
                  <div className="candidateMain">
                    <h3>{thread.title}</h3>
                    <p>{shortWorkspace(thread.cwd)} · {thread.source} · {relativeTime(thread.updatedAt, now)}</p>
                  </div>
                  <span className={`candidateState ${thread.status.kind}`}>{statusMeta[thread.status.kind].label}</span>
                  <button
                    type="button"
                    disabled={busyId === thread.id}
                    onClick={() => mutateTracking(thread.id, "track")}
                  >{busyId === thread.id ? "添加中" : "添加"}</button>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
