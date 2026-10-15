import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { withManagementLock, runtimeEnvironment } from "./management-lock.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function control(state, command) {
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !/^[a-f0-9]{64}$/.test(state.token ?? "")) return false;
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port: state.port });
    let text = "";
    const done = value => { socket.destroy(); resolve(value); };
    socket.setEncoding("utf8");
    socket.setTimeout(1200, () => done(false));
    socket.on("error", () => done(false));
    socket.on("connect", () => socket.write(JSON.stringify({ token: state.token, command }) + "\n"));
    socket.on("data", chunk => {
      text += chunk;
      if (text.length > 1024) return done(false);
      if (!text.includes("\n")) return;
      try {
        const reply = JSON.parse(text.trim());
        done(reply.pid === state.pid && reply.status === (command === "ping" ? "pong" : command === "ready" ? "ready" : "stopping"));
      } catch { done(false); }
    });
    socket.on("end", () => done(false));
  });
}

// OS-independent process plumbing, also exercised on Windows/Linux with a dummy bot.
// Only local-manager exposes it to users, and selects it only on macOS.
export class MacProcess {
  constructor(root) {
    this.root = path.resolve(root);
    this.runtime = path.join(this.root, ".runtime");
    this.stateFile = path.join(this.runtime, "macos-bot.json");
    this.logFile = path.join(this.runtime, "bot.log");
  }
  async state() {
    let state;
    try { state = JSON.parse(await readFile(this.stateFile, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return { running: false };
      throw new Error("Unreadable macOS runtime state. Resolve it before starting another instance.");
    }
    const pidAlive = alive(state.pid);
    const running = pidAlive && await control(state, "ping");
    return { ...state, running, ready: running && await control(state, "ready"), unverified: pidAlive && !running };
  }
  logs() {
    return existsSync(this.logFile) ? readFileSync(this.logFile, "utf8").split(/\r?\n/).slice(-80).join("\n").trim() : "No logs yet.";
  }
  async exclusive(action) {
    await mkdir(this.runtime, { recursive: true, mode: 0o700 });
    await chmod(this.runtime, 0o700);
    return withManagementLock(this.root, action);
  }
  async start() {
    const state = await this.state();
    if (state.running) {
      if (!state.ready) throw new Error("The process is running but Telegram readiness is not confirmed. Inspect Status and Logs; stop it before restarting.");
      return state;
    }
    if (state.unverified) throw new Error("An existing process could not be verified; refusing a duplicate launch.");
    if (!existsSync(path.join(this.root, ".env"))) throw new Error("Configuration missing. Run npm run setup:local.");
    if (!existsSync(path.join(this.root, "dist", "index.js"))) throw new Error("Build missing. Run npm run build.");
    await rm(this.stateFile, { force: true });
    await rm(`${this.logFile}.previous`, { force: true });
    if (existsSync(this.logFile)) await rename(this.logFile, `${this.logFile}.previous`);
    const fd = openSync(this.logFile, "w", 0o600);
    const token = randomBytes(32).toString("hex");
    const child = spawn(process.execPath, ["--enable-source-maps", path.join(this.root, "scripts", "macos-runner.mjs")], {
      cwd: this.root, detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
      env: { ...runtimeEnvironment(), PINK_CONTROL_TOKEN: token },
    });
    let spawnError;
    child.on("error", error => { spawnError = error; });
    child.unref();
    closeSync(fd);
    for (let attempt = 0; attempt < 225; attempt++) {
      await sleep(200);
      if (spawnError || !alive(child.pid)) throw new Error(`Bot startup failed. ${spawnError?.code ?? "See npm run bot:logs."}`);
      const current = await this.state();
      if (current.ready && current.token === token) return current;
    }
    throw new Error("Telegram readiness was not confirmed. Runtime state was preserved; inspect Status and Logs before retrying.");
  }
  async stop() {
    const state = await this.state();
    if (state.unverified) throw new Error("Process ownership could not be verified; no process was stopped.");
    if (!state.running) { await rm(this.stateFile, { force: true }); return; }
    if (!await control(state, "stop")) throw new Error("The bot did not acknowledge Stop. No PID was force-killed.");
    for (let attempt = 0; attempt < 110; attempt++) {
      await sleep(100);
      if (!alive(state.pid) || !existsSync(this.stateFile)) { await rm(this.stateFile, { force: true }); return; }
    }
    throw new Error("Shutdown has not completed. Inspect the logs before restarting.");
  }
}
