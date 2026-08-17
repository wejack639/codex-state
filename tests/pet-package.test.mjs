import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPetPackage } from "../scripts/bridge.mjs";

test("默认皮肤是标准 Codex v2 宠物包", async () => {
  const petDirectory = new URL("../public/pet/", import.meta.url);
  const result = readPetPackage(petDirectory.pathname);
  assert.equal(result.ok, true);
  assert.equal(result.pet.id, "blue-whale-maid");
  assert.equal(result.pet.spriteVersionNumber, 2);
  assert.equal(result.pet.spritesheetPath, "spritesheet.png");
  assert.ok(result.pet.revision);

  const image = await readFile(new URL("spritesheet.png", petDirectory));
  assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(image.readUInt32BE(16), 1536);
  assert.equal(image.readUInt32BE(20), 2288);
});

test("宠物清单拒绝跨目录图集路径", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-state-pet-"));
  try {
    await writeFile(path.join(directory, "pet.json"), JSON.stringify({
      id: "unsafe",
      displayName: "unsafe",
      spriteVersionNumber: 2,
      spritesheetPath: "../spritesheet.png",
    }));
    const result = readPetPackage(directory);
    assert.equal(result.ok, false);
    assert.match(result.error, /当前目录/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
