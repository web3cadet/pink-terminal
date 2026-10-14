import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const helper = pathToFileURL(path.resolve("scripts/uninstall-files.mjs")).href;
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pink-uninstall-test-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pink-terminal" }));
  writeFileSync(path.join(root, ".env"), "SYNTHETIC_TEST_ONLY=unchanged\n");
  return root;
}
function remove(root: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import {removeInstallation} from ${JSON.stringify(helper)};removeInstallation(${JSON.stringify(root)});`], { encoding: "utf8" });
}
describe("bounded uninstall", () => {
  it("deletes app/data while preserving env and unrelated files", () => {
    const root = fixture();
    try {
      mkdirSync(path.join(root, "data"));
      writeFileSync(path.join(root, "data", "history.txt"), "synthetic history");
      writeFileSync(path.join(root, "personal.txt"), "keep");
      const result = remove(root);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(root, "data"))).toBe(false);
      expect(existsSync(path.join(root, "package.json"))).toBe(false);
      expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("SYNTHETIC_TEST_ONLY=unchanged\n");
      expect(existsSync(path.join(root, "personal.txt"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
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
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== "win32")("cancels the actual manager without deleting anything", () => {
    const root = fixture();
    try {
      cpSync(path.resolve("scripts"), path.join(root, "scripts"), { recursive: true });
      const result = spawnSync(process.execPath, [path.join(root, "scripts", "windows-manager.mjs"), "uninstall"], { cwd: root, input: "NO\n", encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("cancelled");
      expect(existsSync(path.join(root, "package.json"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== "win32")("uninstalls via actual manager confirmation in an isolated copy", () => {
    const root = fixture();
    try {
      cpSync(path.resolve("scripts"), path.join(root, "scripts"), { recursive: true });
      const result = spawnSync(process.execPath, [path.join(root, "scripts", "windows-manager.mjs"), "uninstall"], { cwd: root, input: "DELETE\n", encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("UNINSTALLED");
      expect(existsSync(path.join(root, "scripts"))).toBe(false);
      expect(readFileSync(path.join(root, ".env"), "utf8")).toContain("SYNTHETIC_TEST_ONLY");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
