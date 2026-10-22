import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { stopBeforeInstall } = await import(pathToFileURL(path.resolve("scripts/installation-lifecycle.mjs")).href);
const { nodeVersionIsSupported } = await import(pathToFileURL(path.resolve("scripts/local-platform.mjs")).href);
const { isProcessAlive, trackChild, waitForProcessExit } = await import(pathToFileURL(path.resolve("scripts/runtime-process.mjs")).href);
import { EventEmitter } from "node:events";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("installation lifecycle guards", () => {
  it("treats permission-denied PID probes as potentially live", () => {
    const probe = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    try { expect(isProcessAlive(123)).toBe(true); }
    finally { probe.mockRestore(); }
  });
  it("distinguishes process exit from a child close event", async () => {
    const child = new EventEmitter();
    const tracked = trackChild(child);
    child.emit("exit", 1);
    expect(await waitForProcessExit(undefined, { tracked, timeoutMs: 50 })).toBe(false);
    child.emit("close", 1);
    expect(await waitForProcessExit(undefined, { tracked, timeoutMs: 50 })).toBe(true);
  });
  it("bounds waiting without terminating an existing process", async () => {
    expect(await waitForProcessExit(process.pid, { timeoutMs: 50 })).toBe(false);
  });
  it.each(["windows-bot.json", "macos-bot.json"])("stops %s using the packaged manager before replacing anything", state => {
    const root = mkdtempSync(path.join(tmpdir(), "pink-install-guard-")); roots.push(root);
    const source = path.resolve("packaged-source");
    mkdirSync(path.join(root, ".runtime"));
    writeFileSync(path.join(root, ".runtime", state), "{}");
    const run = vi.fn();
    stopBeforeInstall(root, source, run);
    expect(run).toHaveBeenCalledWith(process.execPath, [path.join(source, "scripts", "local-manager.mjs"), "stop"], "Stop before update", { inherit: true });
    run.mockImplementation(() => { throw new Error("Process control unavailable"); });
    expect(() => stopBeforeInstall(root, source, run)).toThrow("Process control unavailable");
  });
  it("does not start a manager for a fresh installation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pink-install-guard-")); roots.push(root);
    const run = vi.fn(); stopBeforeInstall(root, root, run);
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["22.13.0", "22.19.0", "24.0.0", "26.0.0"])("accepts supported Node %s", version => {
    expect(nodeVersionIsSupported(version)).toBe(true);
  });
  it.each(["20.19.0", "22.11.0", "22.12.0", "22.12.99", "23.0.0", "25.0.0", "garbage"])("rejects unsupported Node %s before installation", version => {
    expect(nodeVersionIsSupported(version)).toBe(false);
  });
});
