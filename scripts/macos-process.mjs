import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { withManagementLock, runtimeEnvironment } from "./management-lock.mjs";
import { isProcessAlive, trackChild, waitForProcessExit } from "./runtime-process.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const alive = isProcessAlive;

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
    if (!state || !Number.isSafeInteger(state.pid) || state.pid <= 0 ||
        !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !/^[a-f0-9]{64}$/.test(state.token ?? "")) {
      throw new Error("Invalid macOS runtime state. Refusing to guess which process is running.");
    }
    const pidAlive = alive(state.pid);
    const running = pidAlive && await control(state, "ping");
    return { ...state, running, ready: running && await control(state, "ready"), controlUnavailable: pidAlive && !running };
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
    if (state.controlUnavailable) throw new Error("An existing process is running without a valid control channel; refusing a duplicate launch.");
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
    this.tracked = trackChild(child);
    child.unref();
    closeSync(fd);
    for (let attempt = 0; attempt < 225; attempt++) {
      await sleep(200);
      if (this.tracked.error || !alive(child.pid)) {
        await waitForProcessExit(child.pid, { tracked: this.tracked });
        throw new Error(`Bot startup failed. ${this.tracked.error?.code ?? "See npm run bot:logs."}`);
      }
      const current = await this.state();
      if (current.ready && current.token === token) return current;
    }
    throw new Error("Telegram readiness was not confirmed. Runtime state was preserved; inspect Status and Logs before retrying.");
  }
  async stop() {
    const state = await this.state();
    const pid = state.pid ?? this.tracked?.child.pid;
    const tracked = this.tracked?.child.pid === pid ? this.tracked : undefined;
    if (state.running && !await control(state, "stop") && alive(pid)) {
      throw new Error("The bot did not acknowledge Stop. No PID was force-killed.");
    }
    // An unresponsive process may already be exiting. Wait, but never signal a PID without a valid control channel.
    if (!await waitForProcessExit(pid, { tracked })) {
      throw new Error("Shutdown has not completed or the control channel is unavailable. Runtime state was preserved; no PID was force-killed.");
    }
    await rm(this.stateFile, { force: true });
  }
}
