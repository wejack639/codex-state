# Codex State

本机 Codex 多工作区 / 多 Chat 状态面板。它直接观测 VS Code Codex 在本机写入的会话状态，不依赖 ChatGPT 桌面端的同步速度。

## 启动

macOS 双击 [Codex State.command](./Codex%20State.command)，或在终端运行：

```bash
npm install
npm run floating
```

安装到 `~/Applications`、创建桌面快捷方式，并注册登录自启/异常退出自动重启：

```bash
npm run install:autostart
```

默认启动 macOS 原生宠物式悬浮窗。窗口收起时只保留一个 `64 × 64` 的 ChatGPT 图标球，始终保持在普通窗口上方并跨桌面显示；鼠标悬停时向左下展开，移出后自动收起。按住图标球可拖到其他位置，位置会在重启后恢复。展开后的右上角可退出，退出时本机服务也会一起停止。

如果只想使用浏览器版：

```bash
npm run dashboard
```

浏览器版会自动打开 [http://localhost:3000](http://localhost:3000)。已构建的原生应用位于 `output/Codex State.app`。

## 支持的能力

- 按工作空间分组展示已关注 Chat。
- 收起时只展示运行数和关注数，悬停后展示全部关注项目与 Chat。
- 识别「运行中」「已完成」「已中断」「可能断联」。
- 关注中的 Chat 从「运行中」切换为完成、中断或断联时发送 macOS 通知并播放提示音。
- 实时刷新会话状态和运行时长。
- 从本机最近的 Codex Chat 中搜索并添加关注。
- 从面板移除关注，不删除真实 Chat。
- 一键聚焦 Chat 所在的 VS Code 工作区，并通过插件的本地对话路由打开对应会话。

## 状态判定

面板从 `~/.codex/state_5.sqlite` 读取会话和工作区信息，并从对应 JSONL 事件读取 `task_started`、`task_complete` 和 `turn_aborted`。线程锁用于辅助判断 Chat 是否已在 Codex 中打开。

如果最新事件是 `task_started`，但会话已经长时间没有更新且不再持有线程锁，状态会显示为「可能断联」，而不是误报为运行中。

## 数据边界

- Codex 数据库和会话文件始终只读。
- 关注列表保存在 `~/.codex-state/config.json`。
- 本机桥接只监听 `127.0.0.1:43991`，并且只接受 localhost 页面的写操作。
- 项目保持本地运行：托管到云端的页面无法安全读取你电脑上的 `~/.codex` 状态。

## 开发与验证

```bash
npm run bridge
npm run dev
npm run build:floating
npm test
```

默认端口：页面 `3000`，本机状态桥 `43991`。可通过 `CODEX_STATE_PORT`、`CODEX_STATE_CODEX_ROOT` 和 `CODEX_STATE_DATA_ROOT` 覆盖桥接配置。
