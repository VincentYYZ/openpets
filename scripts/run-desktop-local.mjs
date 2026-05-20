#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const desktopRoot = join(repoRoot, "apps", "desktop");
const userDataPath = join(repoRoot, "local", "openpets-user-data");

await mkdir(userDataPath, { recursive: true });

const child = process.platform === "win32"
  ? spawn(join(desktopRoot, "node_modules", ".bin", "electron.CMD"), ["."], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        OPENPETS_USER_DATA: userDataPath,
      },
      stdio: "inherit",
      windowsHide: false,
      shell: true,
    })
  : spawn(join(desktopRoot, "node_modules", ".bin", "electron"), ["."], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        OPENPETS_USER_DATA: userDataPath,
      },
      stdio: "inherit",
    });

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
