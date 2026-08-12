import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const standaloneDir = path.join(rootDir, ".next", "standalone");
const standaloneNextDir = path.join(standaloneDir, ".next");
const standaloneServerPath = path.join(standaloneDir, "server.js");

/**
 * Mirror, not merge.
 *
 * `cpSync` overwrites what it finds and removes nothing, so a file deleted from
 * `public/` or `.next/static` since the last run stayed in the standalone tree
 * and kept being served. A smoke against that tree is measuring an accumulated
 * mixture of every build ever run here, not the one under test — a removed
 * asset would still pass, and the deployed standalone bundle would carry files
 * the build no longer produces.
 */
function syncDirectory(sourcePath, destinationPath) {
  if (!existsSync(sourcePath)) return;
  rmSync(destinationPath, { recursive: true, force: true });
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  cpSync(sourcePath, destinationPath, {
    force: true,
    recursive: true,
  });
}

syncDirectory(path.join(rootDir, ".next", "static"), path.join(standaloneNextDir, "static"));
syncDirectory(path.join(rootDir, "public"), path.join(standaloneDir, "public"));

const server = spawn(process.execPath, [standaloneServerPath], {
  cwd: standaloneDir,
  env: {
    ...process.env,
    ALLOW_INSECURE_LOCAL_AUTH_COOKIE:
      process.env.ALLOW_INSECURE_LOCAL_AUTH_COOKIE ?? "1",
    HOSTNAME: process.env.HOSTNAME ?? "127.0.0.1",
    PORT: process.env.PORT ?? "3000",
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!server.killed) {
      server.kill(signal);
    }
  });
}

server.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
