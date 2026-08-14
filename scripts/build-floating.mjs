import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.join(projectRoot, "output", "Codex State.app");
const contentsRoot = path.join(appRoot, "Contents");
const macOSRoot = path.join(contentsRoot, "MacOS");
const resourcesRoot = path.join(contentsRoot, "Resources");
const executablePath = path.join(macOSRoot, "CodexState");
const iconsetRoot = path.join(projectRoot, ".build", "AppIcon.iconset");
const appIconPath = path.join(resourcesRoot, "AppIcon.icns");
const nodePath = process.execPath;
const moduleCacheRoot = path.join(projectRoot, ".build", "swift-module-cache");
const compatibleSdkCandidate = "/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk";
const compatibleSdk = existsSync(compatibleSdkCandidate)
  ? compatibleSdkCandidate
  : "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";

rmSync(appRoot, { recursive: true, force: true });
mkdirSync(macOSRoot, { recursive: true });
mkdirSync(resourcesRoot, { recursive: true });
mkdirSync(moduleCacheRoot, { recursive: true });
rmSync(iconsetRoot, { recursive: true, force: true });
mkdirSync(iconsetRoot, { recursive: true });
copyFileSync(path.join(projectRoot, "native", "Info.plist"), path.join(contentsRoot, "Info.plist"));
copyFileSync(
  path.join(projectRoot, "public", "chatgpt-icon.png"),
  path.join(resourcesRoot, "chatgpt-icon.png"),
);

const iconSource = path.join(projectRoot, "public", "chatgpt-icon.png");
const iconSizes = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];
for (const [size, name] of iconSizes) {
  const iconResult = spawnSync("sips", [
    "-z", String(size), String(size), iconSource,
    "--out", path.join(iconsetRoot, name),
  ], { cwd: projectRoot, stdio: "ignore" });
  if (iconResult.status !== 0) process.exit(iconResult.status || 1);
}
const iconBuildResult = spawnSync("iconutil", [
  "-c", "icns", iconsetRoot,
  "-o", appIconPath,
], { cwd: projectRoot, stdio: "inherit" });
if (iconBuildResult.status !== 0) process.exit(iconBuildResult.status || 1);

writeFileSync(
  path.join(resourcesRoot, "runtime.json"),
  `${JSON.stringify({ projectRoot, nodePath }, null, 2)}\n`,
);

const result = spawnSync("xcrun", [
  "swiftc",
  "-O",
  "-sdk", compatibleSdk,
  "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`,
  "-framework", "Cocoa",
  "-framework", "UserNotifications",
  "-framework", "WebKit",
  path.join(projectRoot, "native", "CodexStateApp.swift"),
  "-o", executablePath,
], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: moduleCacheRoot,
    SWIFT_MODULECACHE_PATH: moduleCacheRoot,
  },
});

if (result.status !== 0) process.exit(result.status || 1);

const signResult = spawnSync("codesign", [
  "--force",
  "--deep",
  "--sign", "-",
  appRoot,
], { cwd: projectRoot, stdio: "inherit" });

if (signResult.status !== 0) process.exit(signResult.status || 1);
console.log(`Built ${appRoot}`);
