#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { planUninstall, removeInstallation } from "./uninstall-files.mjs";

const APP_DIR = process.cwd();
const RUNTIME_DIR = path.join(APP_DIR, ".runtime");
const STATE_FILE = path.join(RUNTIME_DIR, "windows-bot.json");
const IDENTITY_FILE = path.join(RUNTIME_DIR, "telegram-bot.json");
const LOG_FILE = path.join(RUNTIME_DIR, "bot.log");
const ENTRY_FILE = path.join(APP_DIR, "dist", "index.js");
const ENV_FILE = path.join(APP_DIR, ".env");

const color = {
  pink: "\u001b[38;2;255;47;111m",
  green: "\u001b[38;2;70;211;105m",
  cyan: "\u001b[38;2;72;199;235m",
  yellow: "\u001b[38;2;255;196;61m",
  red: "\u001b[38;2;255;92;92m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  reset: "\u001b[0m",
};

function print(message = "") { process.stdout.write(`${message}\n`); }
function fail(message) { throw new Error(message); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function readJson(file) {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return {}; }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function isRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function pingPipe(pipeName, timeoutMs = 650) {
  if (typeof pipeName !== "string" || !pipeName.startsWith("\\\\.\\pipe\\polyester-terminal-")) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(pipeName);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("error", () => finish(false));
    socket.on("data", (data) => { if (data.includes("pong")) finish(true); });
    socket.once("connect", () => socket.write("ping\n"));
  });
}

async function currentState() {
  let state = {};
  if (existsSync(STATE_FILE)) {
    try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")); }
    catch { fail("Unreadable runtime state. Refusing to guess which process is running."); }
    if (!state || !Number.isSafeInteger(state.pid) || state.pid <= 0) fail("Invalid runtime state. Refusing a duplicate launch.");
  }
  const pidAlive = isRunning(Number(state.pid));
  const owned = pidAlive && await pingPipe(state.pipeName);
  return { ...state, running: owned, stale: Boolean(state.pid) && !owned };
}

function botLink() {
  const identity = readJson(IDENTITY_FILE);
  return typeof identity.url === "string" ? identity.url : "";
}

async function rotateLog() {
  if (!existsSync(LOG_FILE)) return;
  await rm(`${LOG_FILE}.previous`, { force: true });
  await rename(LOG_FILE, `${LOG_FILE}.previous`);
}

async function startBot() {
  await mkdir(RUNTIME_DIR, { recursive: true });
  const state = await currentState();
  if (state.running) {
    print(`${color.green}${color.bold}RUNNING${color.reset} · PID ${state.pid}`);
    if (botLink()) print(`${color.cyan}${botLink()}${color.reset}`);
    return;
  }
  if (isRunning(Number(state.pid))) fail("An existing process could not be verified; refusing a duplicate launch.");
  if (!existsSync(ENV_FILE)) fail("Configuration is missing. Run npm run setup:windows first.");
  if (!existsSync(ENTRY_FILE)) fail("Build is missing. Run npm run build first.");

  await rotateLog();
  const logFd = openSync(LOG_FILE, "w", 0o600);
  const pipeName = `\\\\.\\pipe\\polyester-terminal-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const runner = path.join(APP_DIR, "scripts", "windows-runner.mjs");
  const child = spawn(process.execPath, ["--enable-source-maps", runner, pipeName], {
    cwd: APP_DIR,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  let spawnError;
  child.on("error", error => { spawnError = error; });
  child.unref();
  closeSync(logFd);
  writeJson(STATE_FILE, { pid: child.pid, pipeName, startedAt: new Date().toISOString() });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(200);
    if (spawnError || !isRunning(child.pid)) break;
    if (await pingPipe(pipeName)) { ready = true; break; }
  }
  if (!ready && isRunning(child.pid)) fail("Background process has not responded. Runtime state was preserved; inspect Status and Logs before retrying.");
  if (!ready) {
    const tail = tailLog(35);
    await rm(STATE_FILE, { force: true });
    fail(`The bot stopped during startup.\n\n${tail}`);
  }
  print(`${color.green}${color.bold}STARTED${color.reset} · PID ${child.pid}`);
  if (botLink()) print(`${color.cyan}${botLink()}${color.reset}`);
}

async function stopBot({ quiet = false } = {}) {
  const state = await currentState();
  if (!state.running) {
    if (isRunning(Number(state.pid))) fail("A process still exists but its control channel could not be verified. No process was killed; runtime state was preserved.");
    await rm(STATE_FILE, { force: true });
    if (!quiet) print(`${color.yellow}Already stopped.${color.reset}`);
    return;
  }
  const graceful = await new Promise((resolve) => {
    const socket = createConnection(state.pipeName);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(1500, () => finish(false));
    socket.once("error", () => finish(false));
    socket.on("data", (data) => { if (data.includes("stopping")) finish(true); });
    socket.once("connect", () => socket.write("stop\n"));
  });
  if (!graceful) fail("The bot ownership check failed; no process was terminated.");
  for (let attempt = 0; attempt < 20 && isRunning(Number(state.pid)); attempt += 1) await sleep(250);
  let result = { status: 0, stderr: "", stdout: "" };
  if (isRunning(Number(state.pid))) {
    result = spawnSync("taskkill.exe", ["/PID", String(state.pid), "/T", "/F"], {
      cwd: APP_DIR,
      windowsHide: true,
      encoding: "utf8",
    });
  }
  if (result.status !== 0 && isRunning(Number(state.pid))) {
    fail(`Could not stop PID ${state.pid}. ${result.stderr || result.stdout || ""}`.trim());
  }
  for (let attempt = 0; attempt < 20 && isRunning(Number(state.pid)); attempt++) await sleep(100);
  if (isRunning(Number(state.pid))) fail("Shutdown has not completed. Runtime state preserved.");
  await rm(STATE_FILE, { force: true });
  if (!quiet) print(`${color.yellow}${color.bold}STOPPED${color.reset} · local data preserved`);
}

async function restartBot() {
  await stopBot({ quiet: true });
  await startBot();
}

async function showStatus() {
  const state = await currentState();
  if (state.running) print(`Status: ${color.green}${color.bold}RUNNING${color.reset} · PID ${state.pid}`);
  else print(`Status: ${color.red}${color.bold}STOPPED${color.reset}${state.stale ? ` ${color.dim}(stale state cleaned on next start)${color.reset}` : ""}`);
  if (state.startedAt) print(`Last start: ${state.startedAt}`);
  if (botLink()) print(`Telegram: ${color.cyan}${botLink()}${color.reset}`);
  print(`Log: ${LOG_FILE}`);
  print("If local management files were deleted: npx --yes github:web3cadet/pink-terminal --stop");
}

function tailLog(lines = 80) {
  if (!existsSync(LOG_FILE)) return "No log file yet.";
  const values = readFileSync(LOG_FILE, "utf8").split(/\r?\n/);
  return values.slice(-lines).join("\n").trim() || "The log is empty.";
}

function showLogs() { print(tailLog()); }

async function reconfigure() {
  await stopBot({ quiet: true });
  const result = spawnSync(process.execPath, [path.join(APP_DIR, "scripts", "windows-installer.mjs"), "--local", "--reconfigure"], {
    cwd: APP_DIR,
    stdio: "inherit",
    windowsHide: false,
  });
  if (result.status !== 0) fail("Reconfiguration did not complete.");
}

async function uninstall() {
  const plan = planUninstall(APP_DIR);
  print(`\nUninstall from: ${plan.root}`);
  print("This stops the managed bot and permanently deletes application files, dependencies, local history and logs.");
  print("The .env file and unrelated top-level files are kept. Do not store personal files inside application directories.");
  print("Exchange orders and strategies are NOT cancelled. Close them in Telegram or on Polyester first if required.");
  print("Node.js, npm cache and the Telegram bot account are NOT removed.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try { answer = await rl.question("Are you sure? Type DELETE to uninstall (Enter cancels): "); }
  finally { rl.close(); }
  if (answer.trim() !== "DELETE") { print("Uninstall cancelled. Nothing changed."); return false; }
  const state = await currentState();
  if (state.stale) fail("Cannot verify the stored bot process. Resolve its status before uninstalling.");
  await stopBot({ quiet: true });
  removeInstallation(APP_DIR);
  print("UNINSTALLED. .env preserved. Local history and logs were deleted; no automatic recovery is provided.");
  return true;
}

function header() {
  process.stdout.write("\u001b[2J\u001b[H");
  print(`${color.pink}${color.bold}PINK TERMINAL${color.reset}`);
  print(`${color.dim}Local Windows instance manager${color.reset}\n`);
}

async function pause() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`\n${color.dim}Press Enter to return to the menu…${color.reset}`);
  rl.close();
}

async function menu() {
  while (true) {
    header();
    await showStatus();
    print(`\n  ${color.green}1)${color.reset} Start`);
    print(`  ${color.yellow}2)${color.reset} Stop`);
    print(`  ${color.cyan}3)${color.reset} Restart`);
    print(`  ${color.cyan}4)${color.reset} Status`);
    print(`  ${color.cyan}5)${color.reset} Recent logs`);
    print(`  ${color.pink}6)${color.reset} Reconfigure credentials`);
    print(`  ${color.red}7)${color.reset} Uninstall (keep .env)`);
    print(`  ${color.dim}0)${color.reset} Exit\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${color.bold}Selection:${color.reset} `)).trim();
    rl.close();
    try {
      if (answer === "1") await startBot();
      else if (answer === "2") await stopBot();
      else if (answer === "3") await restartBot();
      else if (answer === "4") await showStatus();
      else if (answer === "5") showLogs();
      else if (answer === "6") await reconfigure();
      else if (answer === "7") { if (await uninstall()) return; }
      else if (answer === "0") return;
      else { print(`${color.yellow}Choose a number from 0 to 7.${color.reset}`); await sleep(900); continue; }
    } catch (error) {
      print(`${color.red}${error instanceof Error ? error.message : String(error)}${color.reset}`);
    }
    await pause();
  }
}

async function main() {
  if (process.platform !== "win32") fail("This manager is for local Windows installations.");
  const command = (process.argv[2] || "menu").toLowerCase();
  if (command === "start") return startBot();
  if (command === "stop") return stopBot();
  if (command === "restart") return restartBot();
  if (command === "status") return showStatus();
  if (command === "logs") return showLogs();
  if (command === "uninstall") return uninstall();
  if (command === "menu") return menu();
  fail("Unknown command. Use start, stop, restart, status, logs, or no argument for the menu.");
}

main().catch((error) => {
  print(`${color.red}${color.bold}Error:${color.reset} ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
