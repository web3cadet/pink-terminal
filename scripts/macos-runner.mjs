#!/usr/bin/env node
import { createServer } from "node:net";
import { writeFile, rename } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const token = process.env.PINK_CONTROL_TOKEN;
delete process.env.PINK_CONTROL_TOKEN;
if (!/^[a-f0-9]{64}$/.test(token ?? "")) throw new Error("Start the bot through its local manager.");
const stateFile = path.resolve(".runtime", "macos-bot.json");
let stopping = false;
let ready = false;
process.on("pink-terminal-ready", () => { ready = true; });
process.on("pink-terminal-stopping", () => { ready = false; });
const server = createServer(socket => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.setTimeout(2000, () => socket.destroy());
  socket.on("error", () => socket.destroy());
  socket.on("data", chunk => {
    buffer += chunk;
    if (buffer.length > 1024) return socket.destroy();
    if (!buffer.includes("\n")) return;
    let request;
    try { request = JSON.parse(buffer.trim()); } catch { return socket.destroy(); }
    buffer = "";
    if (typeof request.token !== "string" || !/^[a-f0-9]{64}$/.test(request.token)
      || !timingSafeEqual(Buffer.from(token), Buffer.from(request.token))) return socket.destroy();
    if (request.command === "ping") socket.end(JSON.stringify({ pid: process.pid, status: "pong" }) + "\n");
    else if (request.command === "ready") socket.end(JSON.stringify({ pid: process.pid, status: ready && !stopping ? "ready" : "starting" }) + "\n");
    else if (request.command === "stop") {
      socket.end(JSON.stringify({ pid: process.pid, status: "stopping" }) + "\n");
      if (!stopping) {
        stopping = true;
        setImmediate(() => process.emit("SIGTERM", "SIGTERM"));
        // The runner exits itself if graceful application shutdown hangs.
        setTimeout(() => process.exit(1), 8000).unref();
      }
    } else socket.destroy();
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const temp = `${stateFile}.${process.pid}.tmp`;
await writeFile(temp, JSON.stringify({ pid: process.pid, port: server.address().port, token, startedAt: new Date().toISOString() }), { mode: 0o600 });
await rename(temp, stateFile);
try {
  await import(pathToFileURL(path.resolve("dist", "index.js")).href);
} finally {
  await new Promise(resolve => server.close(resolve));
  // Keep the PID until a manager has observed actual exit, not just socket closure.
}
