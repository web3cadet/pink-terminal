import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error The manager's portable formatter is plain JS.
import { formatLogs } from "../scripts/log-view.mjs";

describe("operator log view", () => {
  it("formats severity, timestamp and useful context without dumping JSON", () => {
    const raw = [
      { ts: "2026-10-15T13:21:14.213Z", level: "info", message: "bot_started", mode: "live", apiUrl: "https://example.test" },
      { level: "warn", message: "maintenance_loop_failed", error: "Timed out; retry later" },
      { level: "error", message: "bot_update_failed", error: "Permission denied" }
    ].map(row => JSON.stringify(row)).join("\n");
    const text = formatLogs(raw, { color: true });
    expect(text).toContain("Bot is online"); expect(text).toContain("mode: live");
    expect(text).toContain("2026-10-15 13:21:14 UTC");
    expect(text).toContain("\x1b[1;32m[INFO]"); expect(text).toContain("\x1b[1;31m[ERROR]");
    expect(text).toContain("Timed out"); expect(text).toContain("Permission denied");
    expect(text).not.toContain('"ts":'); expect(text).not.toContain("apiUrl");
    expect(formatLogs(raw, { color: false })).not.toContain("\x1b");
  });
  it("summarizes SQLite's advisory but keeps other warnings, errors and stack traces", () => {
    const text = formatLogs('(node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n(node:1) DeprecationWarning: important warning\nError: failed\n at startup (file.js:10)', { color: false });
    expect(text).toContain("Runtime note:"); expect(text).not.toContain("--trace-warnings");
    expect(text).toContain("DeprecationWarning"); expect(text).toContain("Error: failed"); expect(text).toContain("file.js:10");
  });
  it("redacts nested secrets and strips injected terminal controls", () => {
    const secret = "a".repeat(64), token = "1234567890:" + "b".repeat(30);
    const text = formatLogs(JSON.stringify({ level: "error", message: "problem\x1b[2J", details: { secret, token, error: secret + token }, password: "dontshow" }), { color: false });
    expect(text).not.toContain(secret); expect(text).not.toContain(token); expect(text).not.toContain("dontshow"); expect(text).not.toContain("\x1b");
  });
  it.skipIf(!["win32", "darwin"].includes(process.platform))("renders the actual local manager log command without starting a bot", () => {
    const root = mkdtempSync(path.join(tmpdir(), "Pink log view "));
    try {
      mkdirSync(path.join(root, ".runtime"));
      writeFileSync(path.join(root, ".runtime", "bot.log"), JSON.stringify({ ts: "2026-10-15T13:21:14Z", level: "info", message: "bot_started", mode: "live" }));
      const managers = [process.platform === "win32" ? "windows-manager.mjs" : "macos-manager.mjs"];
      for (const manager of managers) {
        const result = spawnSync(process.execPath, [path.resolve("scripts", manager), "logs"], { cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("PINK TERMINAL  /  RECENT LOGS");
        expect(result.stdout).toContain("Bot is online");
        expect(result.stdout).not.toContain('"level":');
        expect(result.stdout).not.toContain("\x1b");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
