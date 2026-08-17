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

默认启动 macOS 原生宠物式悬浮窗。窗口收起时只保留一个透明背景的 `112 × 128` 人物图标，不使用圆形底板；它始终保持在普通窗口上方并跨桌面显示。鼠标悬停时向左下展开，移出后自动收起。按住人物可拖到其他位置，位置会在重启后恢复。

悬浮人物直接读取标准 Codex 宠物目录 [`public/pet`](./public/pet)：

```text
public/pet/
├── pet.json
└── spritesheet.png   # 也支持 pet.json 指向同目录的 .webp
```

把任意 Codex 宠物目录里的文件全部覆盖到这里即可。面板每 2 秒检查一次，皮肤替换完成后会自动加载，不需要重新安装应用；重新启动时也会直接使用新皮肤。兼容 `spriteVersionNumber` 1（8×9）和 2（8×11），动画行、帧数及节奏与 Codex 宠物一致。`public/panel-icon.png` 只在皮肤缺失或损坏时作为静态兜底，不维护多个皮肤列表。

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
- 点击会话名称可原地修改；名称通过 Codex App Server 正式接口保存，并与 VS Code 同步。
- 一键聚焦 Chat 所在的 VS Code 工作区，并通过插件的本地对话路由打开对应会话。

## 状态判定

面板从 `~/.codex/state_5.sqlite` 读取会话和工作区信息，从 `~/.codex/session_index.jsonl` 读取 VS Code/App Server 使用的最新会话名称，并从对应会话 JSONL 事件读取 `task_started`、`task_complete` 和 `turn_aborted`。线程锁用于辅助判断 Chat 是否已在 Codex 中打开。

如果最新事件是 `task_started`，但会话已经长时间没有更新且不再持有线程锁，状态会显示为「可能断联」，而不是误报为运行中。

## 数据边界

- 面板读取 Codex 数据库和会话文件时始终使用只读连接。
- 修改会话名称只调用 Codex 官方 `thread/name/set`，不会直接更新 `threads.title` 或其他数据库字段。
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

默认端口：页面 `3000`，本机状态桥 `43991`。可通过 `CODEX_STATE_PORT`、`CODEX_STATE_CODEX_ROOT` 和 `CODEX_STATE_DATA_ROOT` 覆盖桥接配置。面板会自动寻找 VS Code Codex 插件或本机 Codex CLI；必要时可用 `CODEX_STATE_CODEX_BIN` 指定 Codex 可执行文件。
