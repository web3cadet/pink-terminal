// CI-only clean installation check. Does not read operator credentials or call trading APIs.
import { mkdtempSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInstallerCommand } from "./installer-process.mjs";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "Pink Terminal install ")));
const packed = runInstallerCommand("npm", ["pack", "--json", "--pack-destination", root], "Pack release");
const pack = JSON.parse(packed.stdout)[0];
if (pack.files.some(file => /(^|\/)\.env$|(^|\/)data\//.test(file.path))) throw new Error("Private files included in package");
const archive = path.join(root, pack.filename);
if (process.platform === "linux") {
  console.log("Linux uses the Docker installer; package manifest checked.");
} else {
  // npm exec exercises the public bin entrypoint and copies from npm's cache into an empty folder.
  const { mkdirSync } = await import("node:fs");
  const target = path.join(root, "Clean user folder");
  mkdirSync(target);
  runInstallerCommand("npm", ["exec", "--yes", `--package=${archive}`, "--", "pink-terminal", "--verify-install"], "Clean packaged installation", { cwd: target, inherit: true });
  if (!existsSync(path.join(target, "dist", "index.js")) || existsSync(path.join(target, ".env"))) throw new Error("Unexpected verification output");
  JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"));
  console.log(`Packaged installation verified on ${process.platform}/${process.arch}. No credentials or trades used.`);
}
