import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, cpSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const helper = pathToFileURL(path.resolve("scripts/uninstall-files.mjs")).href;
function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), "pink-uninstall-test-"));
  const root = path.join(base, "app");
  mkdirSync(root); mkdirSync(path.join(base, "home"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pink-terminal" }));
  writeFileSync(path.join(root, ".env"), "SYNTHETIC_TEST_ONLY=unchanged\n");
  return root;
}
function remove(root: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import {removeInstallation} from ${JSON.stringify(helper)};await removeInstallation(${JSON.stringify(root)});`], { encoding: "utf8", env: testEnv(root) });
}
function testEnv(root: string) { const home = path.join(path.dirname(root), "home"); return { ...process.env, HOME: home, USERPROFILE: home }; }
function cleanup(root: string) {
  const base = path.dirname(root);
  if (!path.basename(base).startsWith("pink-uninstall-test-")) throw new Error("Invalid fixture cleanup path");
  rmSync(base, { recursive: true, force: true });
}
function backupContent(root: string) {
  const home = path.join(path.dirname(root), "home");
  const backups = readdirSync(home).filter(name => name.startsWith("pink-terminal-backup-"));
  expect(backups).toHaveLength(1);
  return readFileSync(path.join(home, backups[0]!, ".env"), "utf8");
}
describe("bounded uninstall", () => {
  it("refuses unidentified residue after package deletion", () => {
    const root = fixture();
    try {
      rmSync(path.join(root, "package.json"));
      mkdirSync(path.join(root, "data"));
      expect(remove(root).status).not.toBe(0);
      expect(existsSync(path.join(root, "data"))).toBe(true);
    } finally { cleanup(root); }
  });
  it("blocks unrelated files before backing up or deleting anything", () => {
    const root = fixture();
    try {
      mkdirSync(path.join(root, "data"));
      writeFileSync(path.join(root, "data", "history.txt"), "synthetic history");
      writeFileSync(path.join(root, "personal.txt"), "keep");
      const result = remove(root);
      expect(result.status).not.toBe(0);
      expect(existsSync(path.join(root, "data"))).toBe(true);
      expect(existsSync(path.join(root, "package.json"))).toBe(true);
      expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("SYNTHETIC_TEST_ONLY=unchanged\n");
      expect(existsSync(path.join(root, "personal.txt"))).toBe(true);
    } finally { cleanup(root); }
  });
  it("backs up exact env bytes outside the app and removes the entire folder", () => {
    const root = fixture();
    try {
      mkdirSync(path.join(root, "data"));
      const result = remove(root);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(root)).toBe(false);
      expect(backupContent(root)).toBe("SYNTHETIC_TEST_ONLY=unchanged\n");
    } finally { cleanup(root); }
  });
  it("keeps the original installation if the backup destination is invalid", () => {
    const root = fixture();
    try {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import {removeInstallation} from ${JSON.stringify(helper)};await removeInstallation(${JSON.stringify(root)},{backupHome:${JSON.stringify(root)}});`], { encoding: "utf8", env: testEnv(root) });
      expect(result.status).not.toBe(0);
      expect(existsSync(path.join(root, "package.json"))).toBe(true);
      expect(existsSync(path.join(root, ".env"))).toBe(true);
    } finally { cleanup(root); }
  });
  it.skipIf(process.platform !== "win32")("Exit at the first disclaimer backs up and removes an identified installed copy without installing or starting", () => {
    const root = fixture();
    try {
      const result = spawnSync(process.execPath, [path.resolve("scripts/windows-installer.mjs")], { cwd: root, input: "2\n", encoding: "utf8", env: testEnv(root) });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain("Exit [bot will be uninstalled; .env backed up]");
      expect(result.stdout).toContain("UNINSTALLED");
      expect(result.stdout).not.toContain("Installing dependencies");
      expect(existsSync(root)).toBe(false);
      expect(backupContent(root)).toContain("SYNTHETIC_TEST_ONLY");
    } finally { cleanup(root); }
  });
  it("refuses source checkouts and wrong packages without changing files", () => {
    const root = fixture();
    try {
      mkdirSync(path.join(root, ".git"));
      expect(remove(root).status).not.toBe(0);
      expect(existsSync(path.join(root, "package.json"))).toBe(true);
      writeFileSync(path.join(root, "package.json"), '{"name":"other-app"}');
      expect(remove(root).status).not.toBe(0);
      expect(existsSync(path.join(root, ".env"))).toBe(true);
    } finally { cleanup(root); }
  });
  it.skipIf(process.platform !== "win32")("cancels the actual manager without deleting anything", () => {
    const root = fixture();
    try {
      cpSync(path.resolve("scripts"), path.join(root, "scripts"), { recursive: true });
      const result = spawnSync(process.execPath, [path.join(root, "scripts", "windows-manager.mjs"), "uninstall"], { cwd: root, input: "NO\n", encoding: "utf8", env: testEnv(root) });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("cancelled");
      expect(existsSync(path.join(root, "package.json"))).toBe(true);
    } finally { cleanup(root); }
  });
  it.skipIf(process.platform !== "win32")("uninstalls via actual manager confirmation in an isolated copy", () => {
    const root = fixture();
    try {
      cpSync(path.resolve("scripts"), path.join(root, "scripts"), { recursive: true });
      const result = spawnSync(process.execPath, [path.join(root, "scripts", "windows-manager.mjs"), "uninstall"], { cwd: root, input: "DELETE\n", encoding: "utf8", env: testEnv(root) });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("UNINSTALLED");
      expect(existsSync(path.join(root, "scripts"))).toBe(false);
      expect(existsSync(root)).toBe(false);
      expect(backupContent(root)).toContain("SYNTHETIC_TEST_ONLY");
      expect(result.stdout).toContain("REINSTALL");
    } finally { cleanup(root); }
  });
});
