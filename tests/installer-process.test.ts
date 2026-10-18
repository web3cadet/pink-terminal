import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const moduleUrl = pathToFileURL(path.resolve("scripts/installer-process.mjs")).href;
function evaluate(code: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import {runInstallerCommand} from ${JSON.stringify(moduleUrl)}; ${code}`], { encoding: "utf8" });
}
describe("installer process runner", () => {
  it("actually runs npm without spawning a Windows cmd shim", () => {
    const result = evaluate(`const r = runInstallerCommand('npm', ['--version'], 'npm'); console.log(r.stdout);`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });
  it("retains the system error when a process cannot start", () => {
    const result = evaluate(`try {runInstallerCommand('missing-pink-terminal-command-123', [], 'Test');} catch (e) {console.log(e.message);}`);
    expect(result.stdout).toContain("ENOENT");
  });
  it("shows the exit code and stderr instead of a generic failure", () => {
    const result = evaluate(`try {runInstallerCommand(process.execPath, ['-e', 'console.error("test failure");process.exit(7)'], 'Test');} catch (e) {console.log(e.message);}`);
    expect(result.stdout).toContain("Exit code 7");
    expect(result.stdout).toContain("test failure");
  });
});
