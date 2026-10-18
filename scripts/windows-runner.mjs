#!/usr/bin/env node

import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const APP_DIR = process.cwd();
const pipeName = process.argv[2];

if (process.platform !== "win32") throw new Error("The Windows runner can only be used on Windows.");
if (typeof pipeName !== "string" || !pipeName.startsWith("\\\\.\\pipe\\polyester-terminal-")) {
  throw new Error("A valid private control pipe is required.");
}

let stopping = false;
let ready = false;
process.on("pink-terminal-ready", () => { ready = true; });
process.on("pink-terminal-stopping", () => { ready = false; });
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.setTimeout(2000, () => socket.destroy());
  socket.on("error", () => socket.destroy());
  socket.on("data", (data) => {
    const command = data.trim().toLowerCase();
    if (command === "ready") { socket.end(ready && !stopping ? "ready\n" : "starting\n"); return; }
    if (command === "ping") {
      socket.end("pong\n");
      return;
    }
    if (command === "stop") {
      socket.end("stopping\n");
      if (!stopping) {
        stopping = true;
        setImmediate(() => process.emit("SIGTERM", "SIGTERM"));
        setTimeout(() => process.exit(1), 8_000).unref();
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
  // Only the manager removes state after verifying that this PID has exited.
}
