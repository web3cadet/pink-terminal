#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { MacProcess } from "./macos-process.mjs";
import { planUninstall, removeInstallation } from "./uninstall-files.mjs";

const root = process.cwd();
const bot = new MacProcess(root);
async function question(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
}
function link() {
  try { const identity = JSON.parse(readFileSync(path.join(root, ".runtime", "telegram-bot.json"), "utf8")); if (identity.url) console.log(identity.url); } catch { /* Optional display metadata. */ }
}
async function status() {
  const state = await bot.state();
  console.log(state.running ? `${state.ready ? "\x1b[32mRUNNING\x1b[0m" : "STARTING · Telegram readiness not confirmed"} · PID ${state.pid}` : state.unverified ? "UNVERIFIED · inspect the existing process" : "STOPPED");
  link();
}
async function command(action) {
  if (action === "status") return status();
  if (action === "logs") return console.log(bot.logs());
  if (!["start", "stop", "restart", "configure", "uninstall"].includes(action)) throw new Error("Unknown management command.");
  if (action === "uninstall") {
    planUninstall(root);
    console.log(`Uninstall from: ${root}\nPermanently removes application files, local history and logs. Keeps .env and unrelated top-level files.\nExchange orders and strategies are not cancelled. Node.js, npm caches and your Telegram bot account remain.`);
    if (await question("Type DELETE to confirm (Enter cancels): ") !== "DELETE") { console.log("Uninstall cancelled."); return false; }
  }
  return bot.exclusive(async () => {
    if (action === "start") { await bot.start(); await status(); }
    if (action === "stop") { await bot.stop(); console.log("STOPPED · local data preserved"); }
    if (action === "restart") { await bot.stop(); await bot.start(); await status(); }
    if (action === "configure") {
      await bot.stop();
      // The child installer inherits ownership, retaining the lock throughout reconfiguration.
      const child = spawnSync(process.execPath, [path.join(root, "scripts", "windows-installer.mjs"), "--local", "--reconfigure"], { cwd: root, stdio: "inherit" });
      if (child.error || child.status !== 0) throw new Error("Configuration was not completed. The bot remains stopped.");
    }
    if (action === "uninstall") {
      await bot.stop();
      removeInstallation(root);
      console.log("UNINSTALLED · .env preserved. Local history and logs deleted; no automatic recovery.");
      return true;
    }
  });
}
async function run(action) {
  return command(action);
}
async function main() {
  if (process.platform !== "darwin") throw new Error("This manager is for macOS. Use npm run manage to select your platform.");
  if (process.argv[2]) return run(process.argv[2]);
  while (true) {
    console.log("\n\x1b[38;2;255;47;111mPINK TERMINAL\x1b[0m · macOS (Beta)");
    await status();
    console.log("\n1) Start\n2) Stop\n3) Restart\n4) Status\n5) Recent logs\n6) Reconfigure credentials\n7) Uninstall (keep .env)\n0) Exit");
    const answer = await question("Selection: ");
    if (answer === "0") return;
    const action = { "1": "start", "2": "stop", "3": "restart", "4": "status", "5": "logs", "6": "configure", "7": "uninstall" }[answer];
    if (!action) continue;
    try { if (await run(action) === true) return; }
    catch (error) { console.error(error.message); }
    await question("Press Enter to return to the menu…");
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
