import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { updateInstallation, assertUpdateTarget, formatUpdateSummary } = await import(pathToFileURL(path.resolve("scripts/update-installation.mjs")).href);
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.resolve(".pink-update-test-")); roots.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pink-terminal" }));
  writeFileSync(path.join(root, ".env"), "FIXTURE=not-a-secret\n");
  mkdirSync(path.join(root, "data"));
  writeFileSync(path.join(root, "data", "history"), "keep history");
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("local update workflow", () => {
  it.each([40, 52, 100])("keeps the update card readable in a %i-column terminal", width => {
    const plain = formatUpdateSummary({ width, color: false });
    expect(plain).not.toContain("\u001b[");
    expect(Math.max(...plain.split("\n").map((line: string) => line.length))).toBeLessThanOrEqual(width);
    expect(plain).toContain("YOUR DATA STAYS");
    expect(plain).toContain("Enter  Cancel");
    const words = plain.replace(/\s+/g, " ");
    expect(words).toContain("Keep .env, local history and saved settings.");
    expect(words).toContain("Exchange orders and strategies are not cancelled.");
    expect(words).toContain("Custom code edits will be replaced.");
    expect(formatUpdateSummary({ width, color: true }).replace(/\u001b\[[0-9;]*m/g, "")).toBe(plain);
  });
  it("stops before invoking the current GitHub main installer with separate arguments", async () => {
    const root = fixture(), events: string[] = [];
    const run = vi.fn(() => events.push("install"));
    const result = await updateInstallation(root, {
      ask: async () => " Y ", stop: async () => { events.push("stop"); }, run, print: () => {},
    });
    expect(result).toBe(true);
    expect(events).toEqual(["stop", "install"]);
    expect(run).toHaveBeenCalledWith("npm", ["exec", "--yes", "--prefer-online", "--package=github:web3cadet/pink-terminal#main", "--", "pink-terminal", "--update"], "Update", { cwd: root, inherit: true });
    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("FIXTURE=not-a-secret\n");
    expect(readFileSync(path.join(root, "data", "history"), "utf8")).toBe("keep history");
  });
  it.each(["", "n", "no"])("cancels %j without stopping or downloading", async answer => {
    const stop = vi.fn(), run = vi.fn();
    expect(await updateInstallation(fixture(), { ask: async () => answer, stop, run, print: () => {} })).toBe(false);
    expect(stop).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });
  it("does not replace files if shutdown cannot be verified", async () => {
    const run = vi.fn();
    await expect(updateInstallation(fixture(), { ask: async () => "y", stop: async () => { throw new Error("Unverified process"); }, run, print: () => {} })).rejects.toThrow("Unverified process");
    expect(run).not.toHaveBeenCalled();
  });
  it("reports a failed installer without claiming success", async () => {
    const print = vi.fn();
    await expect(updateInstallation(fixture(), { ask: async () => "y", stop: async () => {}, run: () => { throw new Error("Exit code 7"); }, print })).rejects.toThrow("Update did not complete");
    expect(print.mock.calls.flat().join(" ")).not.toContain("Update completed");
  });
  it("refuses Git checkouts and missing configuration", () => {
    const root = fixture(); mkdirSync(path.join(root, ".git"));
    expect(() => assertUpdateTarget(root)).toThrow("source Git checkout");
    const missing = fixture(); rmSync(path.join(missing, ".env"));
    expect(() => assertUpdateTarget(missing)).toThrow("Configuration is missing");
  });
  it("refuses unrelated projects", () => {
    const root = fixture(); writeFileSync(path.join(root, "package.json"), '{"name":"unrelated"}');
    expect(() => assertUpdateTarget(root)).toThrow("existing Pink Terminal");
  });
  it("exposes update and configure as standalone commands and locked menu actions on both local platforms", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["bot:update"]).toBe("node scripts/local-manager.mjs update");
    expect(pkg.scripts["bot:configure"]).toBe("node scripts/local-manager.mjs configure");
    const win = readFileSync("scripts/windows-manager.mjs", "utf8");
    expect(win).toContain('command === "update") return withManagementLock(APP_DIR, updateBot)');
    expect(win).toContain('answer === "8") { if (await withManagementLock(APP_DIR, updateBot)) return; }');
    const mac = readFileSync("scripts/macos-manager.mjs", "utf8").replace(/\r\n/g, "\n");
    expect(mac).toContain('"8": "update"');
    expect(mac).toContain('return bot.exclusive(async () => {\n    if (action === "update")');
    const installer = readFileSync("scripts/windows-installer.mjs", "utf8");
    expect(installer.indexOf("assertUpdateTarget(TARGET_DIR)")).toBeLessThan(installer.indexOf("await copyApplication()"));
    expect(installer).toContain("keepExisting && !UPDATE_ONLY");
    expect(installer).toContain("if (!VERIFY_INSTALL) stopBeforeInstall(TARGET_DIR, SOURCE_DIR, run)");
    expect(installer.indexOf("stopBeforeInstall(TARGET_DIR")).toBeLessThan(installer.indexOf("await copyApplication()"));
  });
});
