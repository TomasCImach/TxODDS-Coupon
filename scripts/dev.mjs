import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const commands = [
  ["--filter", "@goaldrop/web", "dev"],
  ["--filter", "@goaldrop/service", "dev"],
  ["--filter", "@goaldrop/service", "dev:indexer"],
  ["--filter", "@goaldrop/service", "dev:oracle"],
  ["--filter", "@goaldrop/service", "dev:settlement"],
  ["--filter", "@goaldrop/service", "dev:demo"],
];
const children = new Set();
let shuttingDown = false;

for (const args of commands) {
  const child = spawn(pnpm, args, {
    detached: process.platform !== "win32",
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (!shuttingDown) shutdown(code ?? 1);
    if (shuttingDown && children.size === 0) process.exit();
  });
  child.once("error", () => shutdown(1));
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (!child.pid) continue;
    try {
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
    } catch {
      // The child already exited.
    }
  }
}
