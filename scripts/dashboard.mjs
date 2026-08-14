import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const vinextCli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));
const childEnvironment = {
  ...process.env,
  WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
};

const children = [
  spawn(process.execPath, ["scripts/bridge.mjs"], {
    cwd: projectRoot,
    env: childEnvironment,
    stdio: "inherit",
  }),
  spawn(process.execPath, [vinextCli, "dev"], {
    cwd: projectRoot,
    env: childEnvironment,
    stdio: "inherit",
  }),
];
const ownerPid = process.ppid;

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Services start independently; retry until both are ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

Promise.all([
  waitFor("http://127.0.0.1:43991/api/health"),
  waitFor("http://localhost:3000/"),
]).then(() => {
  console.log("Codex State: http://localhost:3000");
  if (process.env.CODEX_STATE_NO_OPEN !== "1") {
    spawn("open", ["http://localhost:3000"], { detached: true, stdio: "ignore" }).unref();
  }
}).catch((error) => {
  console.error(error.message);
  stop(1);
});

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 500).unref();
}

for (const child of children) {
  child.on("error", (error) => {
    if (!stopping) {
      console.error(error);
      stop(1);
    }
  });
  child.on("exit", (code, signal) => {
    if (!stopping && (code !== 0 || signal)) stop(code || 1);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

// If the native pet is killed, do not leave bridge/dev-server orphans behind.
setInterval(() => {
  if (process.ppid === 1 || process.ppid !== ownerPid) stop(0);
}, 1000).unref();
