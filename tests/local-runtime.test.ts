import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

async function moduleAt(name: string) { return import(pathToFileURL(path.resolve("scripts", name)).href); }
const dummy = `console.log('fixture_started'); await new Promise(resolve => process.once('SIGTERM', () => { console.log('fixture_stopped'); resolve(); }));`;
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "Pink Terminal runtime ")));
  cpSync(path.resolve("scripts"), path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist", "index.js"), dummy);
  writeFileSync(path.join(root, "package.json"), '{"name":"pink-terminal","type":"module"}');
  writeFileSync(path.join(root, ".env"), 'TEST_FIXTURE_ONLY=keep\n');
  return root;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("local runtimes", () => {
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
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
  it.skipIf(process.platform !== "win32")("existing Windows dispatcher and background manager retain their lifecycle", () => {
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
    } finally { run("stop"); rmSync(root, { recursive: true, force: true }); }
  }, 30000);
  it.skipIf(process.platform !== "darwin")("actual macOS CLI handles start/restart/stop and confirmed uninstall", () => {
    const root = fixture();
    const run = (action: string, input?: string) => spawnSync(process.execPath, [path.join(root, "scripts", "local-manager.mjs"), action], { cwd: root, input, encoding: "utf8", timeout: 20000 });
    try {
      expect(run("start").status).toBe(0);
      expect(run("status").stdout).toContain("RUNNING");
      expect(run("restart").status).toBe(0);
      expect(run("uninstall", "NO\n").stdout).toContain("cancelled");
      expect(run("status").stdout).toContain("RUNNING");
      const result = run("uninstall", "DELETE\n");
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(root, "scripts"))).toBe(false);
      expect(readFileSync(path.join(root, ".env"), "utf8")).toContain("TEST_FIXTURE_ONLY");
    } finally { if (existsSync(path.join(root, "scripts"))) run("stop"); rmSync(root, { recursive: true, force: true }); }
  }, 30000);
});
