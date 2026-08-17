import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("服务端输出 Codex State 首屏", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Codex State/);
  assert.match(html, /MISSION CONTROL/);
  assert.match(html, /添加 Chat/);
  assert.match(html, /本机工作台/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("已清理临时骨架屏并保留正式元数据", async () => {
  const [page, petSprite, layout, packageJson, styles, nativeApp, buildFloating, petManifest] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/pet-sprite.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../native/CodexStateApp.swift", import.meta.url), "utf8"),
    readFile(new URL("../scripts/build-floating.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/pet/pet.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /EventSource/);
  assert.match(page, /URLSearchParams/);
  assert.match(page, /mutateTracking\(thread\.id, "track"\)/);
  assert.match(page, /mutateTracking\(thread\.id, "untrack"\)/);
  assert.match(page, /\/api\/open-thread/);
  assert.match(page, /\/api\/rename-thread/);
  assert.match(page, /ThreadNameEditor/);
  assert.match(page, /修改会话名称/);
  assert.match(page, /maxLength=\{80\}/);
  assert.doesNotMatch(page, /onBlur=\{handleBlur\}/);
  assert.match(page, /openThreadAndCollapse/);
  assert.match(page, /openThread\(threadId\)\.finally/);
  assert.match(page, /expandSuppressedUntil/);
  assert.match(page, /suppressExpansionMs/);
  assert.match(page, /aria-label="收回面板"/);
  assert.match(page, /postPanelMessage\(\{ type: "resize", expanded: false \}\)/);
  assert.match(page, /window\.screen\.availHeight/);
  assert.match(page, /workspaceColumns/);
  assert.match(page, /multiColumn/);
  assert.match(page, /CodexPetSprite/);
  assert.match(page, /running-right/);
  assert.match(page, /running-left/);
  assert.doesNotMatch(page, /petQuit|type: "quit"/);
  assert.match(page, /恢复此 Chat/);
  assert.doesNotMatch(page, /打开工作区 ↗/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(layout, /Codex State/);
  assert.match(styles, /url\("\/panel-icon\.png"\)/);
  assert.match(styles, /\.codexPetSprite/);
  assert.match(styles, /\.petOrb \{[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
  assert.match(styles, /filter: drop-shadow/);
  assert.match(nativeApp, /collapsedSize = NSSize\(width: 112, height: 128\)/);
  assert.match(nativeApp, /panel\.hasShadow = false/);
  assert.match(nativeApp, /expanded \? 22 : 0/);
  assert.match(nativeApp, /currentPetLoadingAsset/);
  assert.match(nativeApp, /800%/);
  assert.match(buildFloating, /public", "panel-icon\.png/);
  assert.match(petSprite, /spriteVersionNumber: 1 \| 2/);
  assert.match(petSprite, /PET_ROWS = \{ 1: 9, 2: 11 \}/);
  assert.match(petSprite, /PET_REFRESH_MS = 2_000/);
  assert.match(petSprite, /image\.naturalWidth !== 1536/);
  assert.match(petSprite, /data-codex-pet-state/);
  assert.equal(JSON.parse(petManifest).spriteVersionNumber, 2);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("../public/panel-icon.png", import.meta.url));
  await access(new URL("../public/pet/spritesheet.png", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
