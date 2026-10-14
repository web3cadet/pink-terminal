#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const APP_DIR = process.cwd();
const STATE_FILE = path.join(APP_DIR, ".runtime", "windows-bot.json");
const pipeName = process.argv[2];

if (process.platform !== "win32") throw new Error("The Windows runner can only be used on Windows.");
if (typeof pipeName !== "string" || !pipeName.startsWith("\\\\.\\pipe\\polyester-terminal-")) {
  throw new Error("A valid private control pipe is required.");
}

let stopping = false;
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.on("data", (data) => {
    const command = data.trim().toLowerCase();
    if (command === "ping") {
      socket.end("pong\n");
      return;
    }
    if (command === "stop") {
      socket.end("stopping\n");
      if (!stopping) {
        stopping = true;
        setImmediate(() => process.emit("SIGTERM", "SIGTERM"));
        setTimeout(() => process.exit(0), 8_000).unref();
      }
      return;
    }
    socket.end("unknown\n");
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(pipeName, resolve);
});

try {
  await import(pathToFileURL(path.join(APP_DIR, "dist", "index.js")).href);
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (Number(state.pid) === process.pid && state.pipeName === pipeName) await rm(STATE_FILE, { force: true });
    } catch { /* A malformed state file is left for the manager to report as stale. */ }
  }
}
