import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtApp = path.join(projectRoot, "output", "Codex State.app");
const userRoot = os.homedir();
const applicationsRoot = path.join(userRoot, "Applications");
const installedApp = path.join(applicationsRoot, "Codex State.app");
const executable = path.join(installedApp, "Contents", "MacOS", "CodexState");
const desktopLink = path.join(userRoot, "Desktop", "Codex State.app");
const launchAgentsRoot = path.join(userRoot, "Library", "LaunchAgents");
const launchAgentPath = path.join(launchAgentsRoot, "com.domino.codex-state.plist");
const stateRoot = path.join(userRoot, ".codex-state");
const label = "com.domino.codex-state";
const serviceTarget = `gui/${process.getuid()}/${label}`;

function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, { stdio: allowFailure ? "ignore" : "inherit" });
  if (!allowFailure && result.status !== 0) process.exit(result.status || 1);
}

if (!existsSync(builtApp)) throw new Error(`未找到构建产物：${builtApp}`);

mkdirSync(applicationsRoot, { recursive: true });
mkdirSync(launchAgentsRoot, { recursive: true });
mkdirSync(stateRoot, { recursive: true, mode: 0o700 });

run("launchctl", ["bootout", serviceTarget], true);
run("osascript", ["-e", `tell application id "${label}" to quit`], true);
run("/bin/sleep", ["0.5"], true);

rmSync(installedApp, { recursive: true, force: true });
run("ditto", [builtApp, installedApp]);

if (existsSync(desktopLink) || lstatExists(desktopLink)) {
  const stat = lstatSync(desktopLink);
  if (!stat.isSymbolicLink()) {
    throw new Error(`桌面已存在非快捷方式文件，未覆盖：${desktopLink}`);
  }
  const currentTarget = readlinkSync(desktopLink);
  if (currentTarget !== installedApp) rmSync(desktopLink);
}
if (!existsSync(desktopLink) && !lstatExists(desktopLink)) {
  symlinkSync(installedApp, desktopLink);
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${executable}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${projectRoot}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>2</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>${path.join(stateRoot, "launchd.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(stateRoot, "launchd-error.log")}</string>
</dict>
</plist>
`;
writeFileSync(launchAgentPath, plist, { mode: 0o644 });
chmodSync(launchAgentPath, 0o644);
run("plutil", ["-lint", launchAgentPath]);
run("launchctl", ["bootstrap", `gui/${process.getuid()}`, launchAgentPath]);
run("launchctl", ["kickstart", serviceTarget]);

console.log(`Installed ${installedApp}`);
console.log(`Desktop shortcut ${desktopLink}`);
console.log(`KeepAlive ${launchAgentPath}`);

function lstatExists(target) {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}
