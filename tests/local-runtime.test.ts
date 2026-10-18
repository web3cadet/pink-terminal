import { describe, it, expect } from "vitest";
import { mkdtempSync, copyFileSync, readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";

async function moduleAt(name: string) { return import(pathToFileURL(path.resolve("scripts", name)).href); }
const dummy = `console.log('fixture_started'); process.emit('pink-terminal-ready'); await new Promise(resolve => process.once('SIGTERM', () => { console.log('fixture_stopped'); resolve(); }));`;
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "Pink Terminal тест runtime ")));
  mkdirSync(path.join(root, "scripts"));
  for (const file of readdirSync(path.resolve("scripts"))) copyFileSync(path.resolve("scripts", file), path.join(root, "scripts", file));
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist", "index.js"), dummy);
  writeFileSync(path.join(root, "package.json"), '{"name":"pink-terminal","type":"module"}');
  writeFileSync(path.join(root, ".env"), 'TEST_FIXTURE_ONLY=keep\n');
  return root;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function cleanupFixture(root: string) {
  if (path.dirname(root) !== realpathSync(tmpdir()) || !path.basename(root).startsWith("Pink Terminal тест runtime ")) throw new Error("Unexpected fixture path");
  // Async retries allow child close events to release Windows process/cwd handles.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

describe("local runtimes", () => {
  it("waits for actual Mac process exit even after the control socket closes", async () => {
    const root = fixture();
    writeFileSync(path.join(root, "dist/index.js"), "process.emit('pink-terminal-ready'); await new Promise(resolve => process.once('SIGTERM', () => { setTimeout(() => console.log('exit_tail'), 1200); resolve(); }));");
    const { MacProcess, alive } = await moduleAt("macos-process.mjs");
    const starter = new MacProcess(root), stopper = new MacProcess(root);
    try {
      const started = await starter.exclusive(() => starter.start());
      const at = Date.now();
      await stopper.exclusive(() => stopper.stop());
      expect(Date.now() - at).toBeGreaterThanOrEqual(1000);
      expect(alive(started.pid)).toBe(false);
      expect(existsSync(stopper.stateFile)).toBe(false);
      expect(starter.logs()).toContain("exit_tail");
    } finally { await starter.exclusive(() => starter.stop()); await cleanupFixture(root); }
  }, 15000);

  it("preserves malformed Mac state rather than treating it as stopped", async () => {
    const root = fixture();
    const { MacProcess } = await moduleAt("macos-process.mjs");
    const bot = new MacProcess(root);
    try {
      mkdirSync(path.join(root, ".runtime"));
      for (const raw of ["null", "{}", "{broken", JSON.stringify({ pid: process.pid, port: 1, token: "bad" })]) {
        writeFileSync(bot.stateFile, raw);
        await expect(bot.exclusive(() => bot.start())).rejects.toThrow(/runtime state/);
        await expect(bot.exclusive(() => bot.stop())).rejects.toThrow(/runtime state/);
        expect(readFileSync(bot.stateFile, "utf8")).toBe(raw);
      }
    } finally { await cleanupFixture(root); }
  });
  it.skipIf(process.platform !== "win32")("Windows stop waits for exit after the pipe closes", async () => {
    const root = fixture();
    writeFileSync(path.join(root, "dist/index.js"), "process.emit('pink-terminal-ready'); await new Promise(resolve => process.once('SIGTERM', () => { setTimeout(() => console.log('exit_tail'), 1200); resolve(); }));");
    const run = (action: string) => spawnSync(process.execPath, [path.join(root, "scripts/local-manager.mjs"), action], { cwd: root, encoding: "utf8", timeout: 20000, windowsHide: true });
    const { alive } = await moduleAt("macos-process.mjs");
    try {
      expect(run("start").status).toBe(0);
      const state = JSON.parse(readFileSync(path.join(root, ".runtime/windows-bot.json"), "utf8"));
      const at = Date.now();
      const stopped = run("stop");
      expect(stopped.status, stopped.stderr + stopped.stdout).toBe(0);
      expect(Date.now() - at).toBeGreaterThanOrEqual(1000);
      expect(alive(state.pid)).toBe(false);
      expect(run("logs").stdout).toContain("exit_tail");
    } finally { run("stop"); await cleanupFixture(root); }
  }, 15000);
  it("does not report Mac startup success when the control channel opens but the app fails", async () => {
    const root = fixture();
    writeFileSync(path.join(root, "dist/index.js"), "await new Promise(resolve => setTimeout(resolve, 600)); throw new Error('fixture startup failure');");
    const { MacProcess } = await moduleAt("macos-process.mjs");
    const bot = new MacProcess(root);
    try {
      await expect(bot.exclusive(() => bot.start())).rejects.toThrow(/startup failed/);
      expect((await bot.state()).running).toBe(false);
    } finally {
      await bot.exclusive(() => bot.stop());
      await cleanupFixture(root);
    }
  }, 15000);
  it.skipIf(process.platform !== "win32")("does not report Windows startup success before Telegram readiness", async () => {
    const root = fixture();
    writeFileSync(path.join(root, "dist/index.js"), "await new Promise(resolve => setTimeout(resolve, 600)); throw new Error('fixture startup failure');");
    const run = (action: string) => spawnSync(process.execPath, [path.join(root, "scripts/local-manager.mjs"), action], { cwd: root, encoding: "utf8", timeout: 15000 });
    try {
      const result = run("start");
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("STARTED");
      expect(run("status").stdout).toContain("STOPPED");
    } finally { run("stop"); await cleanupFixture(root); }
  }, 20000);
  it.skipIf(process.platform !== "win32")("preserves corrupt or unverified Windows state", async () => {
    const root = fixture();
    const run = (action: string) => spawnSync(process.execPath, [path.join(root, "scripts/local-manager.mjs"), action], { cwd: root, encoding: "utf8", timeout: 15000 });
    try {
      mkdirSync(path.join(root, ".runtime"));
      const stateFile = path.join(root, ".runtime/windows-bot.json");
      for (const state of ["{broken", JSON.stringify({ pid: process.pid, pipeName: "invalid" })]) {
        writeFileSync(stateFile, state);
        expect(run("start").status).not.toBe(0);
        expect(run("stop").status).not.toBe(0);
        expect(readFileSync(stateFile, "utf8")).toBe(state);
      }
    } finally { await cleanupFixture(root); }
  });
  it.skipIf(process.platform !== "win32")("waits for a slow Windows control channel", async () => {
    const root = fixture();
    const runner = path.join(root, "scripts/windows-runner.mjs");
    writeFileSync(runner, readFileSync(runner, "utf8").replace('let stopping = false;', 'await new Promise(resolve => setTimeout(resolve, 2200));\nlet stopping = false;'));
    const run = (action: string) => spawnSync(process.execPath, [path.join(root, "scripts/local-manager.mjs"), action], { cwd: root, encoding: "utf8", timeout: 20000 });
    try {
      const started = run("start");
      expect(started.status, started.stdout + started.stderr).toBe(0);
      expect(run("status").stdout).toContain("RUNNING");
    } finally { run("stop"); await cleanupFixture(root); }
  }, 30000);
  it.skipIf(!["win32", "darwin"].includes(process.platform))("recovers stop and uninstall after installed scripts and package were deleted", async () => {
    const root = fixture();
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "Pink Terminal тест runtime home ")));
    const external = path.resolve("scripts/windows-installer.mjs");
    const recovery = (action: string, input?: string) => spawnSync(process.execPath, [external, "--" + action], { cwd: root, input, encoding: "utf8", timeout: 20000, env: { ...process.env, HOME: home, USERPROFILE: home } });
    try {
      const start = spawnSync(process.execPath, [path.join(root, "scripts/local-manager.mjs"), "start"], { cwd: root, encoding: "utf8" });
      expect(start.status, start.stderr + start.stdout).toBe(0);
      writeFileSync(path.join(root, ".runtime/install-source.json"), JSON.stringify({ command: "npx --yes github:web3cadet/pink-terminal" }));
      mkdirSync(path.join(root, "data"));
      writeFileSync(path.join(root, "data/history.txt"), "fixture");
      writeFileSync(path.join(root, "personal.txt"), "keep");
      rmSync(path.join(root, "scripts"), { recursive: true });
      rmSync(path.join(root, "dist"), { recursive: true });
      rmSync(path.join(root, "package.json"));
      expect(recovery("status").stdout).toContain("RUNNING");
      const blocked = recovery("uninstall", "DELETE\n");
      expect(blocked.status).not.toBe(0);
      expect(blocked.stdout + blocked.stderr).toContain("unrelated files");
      expect(recovery("status").stdout).toContain("RUNNING");
      copyFileSync(path.join(root, "personal.txt"), path.join(home, "personal.txt"));
      rmSync(path.join(root, "personal.txt"));
      expect(recovery("uninstall", "NO\n").stdout).toContain("cancelled");
      expect(recovery("status").stdout).toContain("RUNNING");
      const stop = recovery("stop");
      expect(stop.status, stop.stdout + stop.stderr).toBe(0);
      expect(recovery("status").stdout).toContain("STOPPED");
      const removed = recovery("uninstall", "DELETE\n");
      expect(removed.status, removed.stdout + removed.stderr).toBe(0);
      expect(existsSync(path.join(root, ".runtime"))).toBe(false);
      expect(existsSync(path.join(root, "data"))).toBe(false);
      expect(existsSync(root)).toBe(false);
      const backup = readdirSync(home).find(name => name.startsWith("pink-terminal-backup-"));
      expect(backup).toBeTruthy();
      expect(readFileSync(path.join(home, backup!, ".env"), "utf8")).toContain("TEST_FIXTURE_ONLY");
      expect(readFileSync(path.join(home, "personal.txt"), "utf8")).toBe("keep");
    } finally { if (existsSync(root)) recovery("stop"); await cleanupFixture(root); await cleanupFixture(home); }
  }, 30000);
  it("routes Windows to the existing manager and Mac to its beta manager", async () => {
    const { localPlatform } = await moduleAt("local-platform.mjs");
    expect(localPlatform("win32").manager).toBe("windows-manager.mjs");
    expect(localPlatform("darwin").manager).toBe("macos-manager.mjs");
    expect(() => localPlatform("linux")).toThrow(/Ubuntu/);
  });
  it("Mac process engine starts once, rejects an invalid control token, stops and restarts", async () => {
    const root = fixture();
    const { MacProcess, control } = await moduleAt("macos-process.mjs");
    const bot = new MacProcess(root);
    try {
      const first = await bot.exclusive(() => bot.start());
      for (let i = 0; i < 30 && !bot.logs().includes("fixture_started"); i++) await delay(100);
      expect(bot.logs()).toContain("fixture_started");
      const again = await bot.exclusive(() => bot.start());
      expect(again.pid).toBe(first.pid);
      expect(await control({ ...first, token: "0".repeat(64) }, "stop")).toBe(false);
      expect((await bot.state()).running).toBe(true);
      await bot.exclusive(() => bot.stop());
      expect((await bot.state()).running).toBe(false);
      expect(bot.logs()).toContain("fixture_stopped");
      const restarted = await bot.exclusive(() => bot.start());
      expect(restarted.pid).not.toBe(first.pid);
      expect(readFileSync(path.join(root, ".env"), "utf8")).toBe('TEST_FIXTURE_ONLY=keep\n');
      await expect(bot.exclusive(() => bot.exclusive(() => bot.start()))).rejects.toThrow(/Another management/);
    } finally {
      await bot.exclusive(() => bot.stop());
      await cleanupFixture(root);
    }
  }, 20000);
  it.skipIf(process.platform !== "win32")("existing Windows dispatcher and background manager retain their lifecycle", async () => {
    const root = fixture();
    const run = (action: string) => spawnSync(process.execPath, [path.join(root, "scripts", "local-manager.mjs"), action], { cwd: root, encoding: "utf8", timeout: 20000 });
    try {
      const start = run("start");
      expect(start.status, start.stdout + start.stderr).toBe(0);
      expect(run("status").stdout).toContain("RUNNING");
      const restart = run("restart");
      expect(restart.status, restart.stdout + restart.stderr).toBe(0);
      expect(run("logs").stdout).toContain("fixture_started");
      expect(run("stop").status).toBe(0);
      expect(run("status").stdout).toContain("STOPPED");
      expect(existsSync(path.join(root, ".env"))).toBe(true);
    } finally { run("stop"); await cleanupFixture(root); }
  }, 30000);
  it.skipIf(process.platform !== "darwin")("actual macOS CLI handles start/restart/stop and confirmed uninstall", async () => {
    const root = fixture();
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "Pink Terminal тест runtime home ")));
    const run = (action: string, input?: string) => spawnSync(process.execPath, [path.join(root, "scripts", "local-manager.mjs"), action], { cwd: root, input, encoding: "utf8", timeout: 20000, env: { ...process.env, HOME: home, USERPROFILE: home } });
    try {
      expect(run("start").status).toBe(0);
      expect(run("status").stdout).toContain("RUNNING");
      expect(run("restart").status).toBe(0);
      expect(run("uninstall", "NO\n").stdout).toContain("cancelled");
      expect(run("status").stdout).toContain("RUNNING");
      const result = run("uninstall", "DELETE\n");
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(root)).toBe(false);
      const backups = readdirSync(home).filter(name => name.startsWith("pink-terminal-backup-"));
      expect(backups).toHaveLength(1);
      expect(readFileSync(path.join(home, backups[0]!, ".env"), "utf8")).toBe('TEST_FIXTURE_ONLY=keep\n');
    } finally { if (existsSync(path.join(root, "scripts"))) run("stop"); await cleanupFixture(root); await cleanupFixture(home); }
  }, 30000);
});
