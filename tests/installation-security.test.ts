import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, realpathSync } from "node:fs";
import { cp } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = (name: string) => pathToFileURL(path.resolve("scripts", name)).href;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function run(script: string, root: string, env = process.env) {
  return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env, windowsHide: true });
    let out = "";
    p.stdout.on("data", x => { out += x; }); p.stderr.on("data", x => { out += x; });
    p.once("error", reject); p.once("close", code => resolve({ code, out }));
  });
}
describe("installation security", () => {
  it("writes, replaces, edits and deletes a private config without changing directory permissions", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "Pink secrets тест ")));
    const file = path.join(root, ".env");
    const { writeSecretFile, protectSecretFile } = await import(moduleUrl("secret-file.mjs"));
    try {
      await writeSecretFile(file, "FIXTURE=first\n");
      await writeSecretFile(file, "FIXTURE=second\n");
      expect(readFileSync(file, "utf8")).toBe("FIXTURE=second\n");
      await protectSecretFile(file);
      expect(readdirSync(root)).toEqual([".env"]);
      if (process.platform === "win32") {
        const script = `$a=[System.IO.File]::GetAccessControl($env:PINK_ACL_TEST); [pscustomobject]@{protected=$a.AreAccessRulesProtected;owner=$a.Owner;current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;rules=@($a.Access|ForEach-Object{[pscustomobject]@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;rights=[int]$_.FileSystemRights;type=[string]$_.AccessControlType;inherited=$_.IsInherited}})}|ConvertTo-Json -Depth 4 -Compress`;
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, env: { ...process.env, PINK_ACL_TEST: file } });
        expect(result.status, result.stderr).toBe(0);
        const acl = JSON.parse(result.stdout.trim());
        expect(acl.protected).toBe(true);
        expect(acl.rules.map((r: { sid: string }) => r.sid).sort()).toEqual([acl.current, "S-1-5-18", "S-1-5-32-544"].sort());
        expect(acl.rules.every((r: { type: string; inherited: boolean; rights: number }) => r.type === "Allow" && !r.inherited && r.rights === 2032127)).toBe(true);
      } else expect(statSync(file).mode & 0o777).toBe(0o600);
      writeFileSync(file, "FIXTURE=edited\n");
      expect(readFileSync(file, "utf8")).toBe("FIXTURE=edited\n");
      rmSync(file);
      writeFileSync(path.join(root, "ordinary.txt"), "can still use folder");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it("failed replacement preserves the destination and removes temporary files", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pink-secret-failure-"));
    const { writeSecretFile } = await import(moduleUrl("secret-file.mjs"));
    try {
      mkdirSync(path.join(root, ".env"));
      writeFileSync(path.join(root, ".env/keep.txt"), "keep");
      await expect(writeSecretFile(path.join(root, ".env"), "FIXTURE=1")).rejects.toThrow();
      expect(readFileSync(path.join(root, ".env/keep.txt"), "utf8")).toBe("keep");
      expect(readdirSync(root)).toEqual([".env"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15000);

  it.skipIf(!["win32", "darwin"].includes(process.platform))("serializes concurrent starts and releases the lock for stop", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pink-management-race-"));
    const manager = path.join(root, "scripts", process.platform === "win32" ? "windows-manager.mjs" : "macos-manager.mjs");
    const action = (name: string) => run(`process.argv[2]=${JSON.stringify(name)}; await import(${JSON.stringify(pathToFileURL(manager).href)});`, root);
    try {
      await cp(path.resolve("scripts"), path.join(root, "scripts"), { recursive: true });
      mkdirSync(path.join(root, "dist"));
      writeFileSync(path.join(root, ".env"), "FIXTURE=1");
      writeFileSync(path.join(root, "dist/index.js"), "process.emit('pink-terminal-ready'); await new Promise(resolve => process.once('SIGTERM', resolve));");
      if (process.platform === "win32") writeFileSync(manager, readFileSync(manager, "utf8").replace("await rotateLog();", "await sleep(700); await rotateLog();"));
      else {
        const engine = path.join(root, "scripts/macos-process.mjs");
        writeFileSync(engine, readFileSync(engine, "utf8").replace("const state = await this.state();", "await sleep(700); const state = await this.state();"));
      }
      for (let repeat = 0; repeat < 3; repeat++) {
        const results = await Promise.all([action("start"), action("start")]);
        expect(results.filter(x => x.code === 0).length, JSON.stringify(results)).toBe(1);
        expect(results.filter(x => x.code !== 0)[0]?.out).toContain("Another management");
        expect((await action("stop")).code).toBe(0);
      }
    } finally { await action("stop"); await delay(300); rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it("supports child installer/manager nesting and releases locks after exceptions or process death", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pink-lock-lifetime-"));
    const preamble = `import {withManagementLock} from ${JSON.stringify(moduleUrl("management-lock.mjs"))};`;
    try {
      const nested = `import {spawnSync} from 'node:child_process'; ${preamble} await withManagementLock(process.cwd(),async()=>{const r=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(preamble + "await withManagementLock(process.cwd(),()=>console.log('nested-ok')); ")}],{encoding:'utf8'}); console.log(r.stdout); process.exitCode=r.status;});`;
      expect((await run(nested, root)).out).toContain("nested-ok");
      expect((await run(preamble + "await withManagementLock(process.cwd(),()=>{throw Error('fixture')});", root)).code).not.toBe(0);
      expect((await run(preamble + "await withManagementLock(process.cwd(),()=>process.exit(7));", root)).code).toBe(7);
      expect((await run(preamble + "await withManagementLock(process.cwd(),()=>{});", root)).code).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15000);
});
