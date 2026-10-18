import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, readdirSync, rmdirSync, mkdtempSync } from "node:fs";
import { writeSecretFile } from "./secret-file.mjs";
import path from "node:path";
import os from "node:os";

const names = JSON.parse(readFileSync(new URL("./uninstall-files.json", import.meta.url), "utf8"));

export function planUninstall(directory) {
  const root = realpathSync(directory);
  if (lstatSync(path.resolve(directory)).isSymbolicLink() || root === path.parse(root).root || root === realpathSync(os.homedir())) {
    throw new Error("Refusing uninstall from a linked or broad directory.");
  }
  const packageFile = path.join(root, "package.json");
  const partial = !existsSync(packageFile);
  const marker = path.join(root, ".runtime", "install-source.json");
  if (partial && (!existsSync(marker) || lstatSync(path.join(root, ".runtime")).isSymbolicLink() || lstatSync(marker).isSymbolicLink() ||
      JSON.parse(readFileSync(marker, "utf8")).command !== "npx --yes github:web3cadet/pink-terminal")) {
    throw new Error("Cannot identify this damaged installation. No files were deleted.");
  }
  if (!partial && (lstatSync(packageFile).isSymbolicLink() || JSON.parse(readFileSync(packageFile, "utf8")).name !== "pink-terminal")) {
    throw new Error("Not a Pink Terminal installation.");
  }
  if (existsSync(path.join(root, ".git"))) throw new Error("Uninstall is disabled in a source Git checkout. Use a dedicated installed copy.");
  // Without package identity, clean only known runtime residue, not application-like folders.
  const targets = (partial ? [".runtime", "data"] : names).map(name => path.join(root, name)).filter(file => existsSync(file));
  const allowed = new Set(targets.map(file => path.basename(file)).concat(".env"));
  if (readdirSync(root).some(name => !allowed.has(name))) {
    throw new Error("Installation folder contains unrelated files. Move them out before uninstalling; nothing was deleted.");
  }
  const env = path.join(root, ".env");
  if (existsSync(env) && (!lstatSync(env).isFile() || lstatSync(env).isSymbolicLink() || lstatSync(env).nlink !== 1)) {
    throw new Error("Refusing a linked or non-file .env. Nothing was deleted.");
  }
  for (const file of targets) {
    if (path.basename(file).toLowerCase() === ".env" || path.dirname(file) !== root || lstatSync(file).isSymbolicLink() || realpathSync(file) !== file) {
      throw new Error("Refusing uninstall: linked or out-of-folder target.");
    }
  }
  return { root, targets };
}

export async function removeInstallation(directory, { backupHome = os.homedir(), print = console.log } = {}) {
  const plan = planUninstall(directory);
  const home = realpathSync(backupHome);
  if (home === plan.root || home.startsWith(plan.root + path.sep)) throw new Error("Backup must be outside the installation.");
  const env = path.join(plan.root, ".env");
  let backup;
  if (existsSync(env)) {
    const content = readFileSync(env);
    const folder = mkdtempSync(path.join(home, "pink-terminal-backup-"));
    backup = path.join(folder, ".env");
    await writeSecretFile(backup, content);
    if (!readFileSync(backup).equals(content)) throw new Error("Configuration backup verification failed. Nothing was deleted.");
    print(`Configuration backup: ${backup}`);
  }
  planUninstall(directory);
  if (backup && !readFileSync(env).equals(readFileSync(backup))) throw new Error("Configuration changed during backup; deletion cancelled.");
  const cwd = process.cwd();
  if (cwd === plan.root || cwd.startsWith(plan.root + path.sep)) process.chdir(home);
  for (const file of plan.targets) rmSync(file, { recursive: true, force: true });
  if (backup) rmSync(env);
  let folderRemoved = true;
  try { rmdirSync(plan.root); }
  catch (error) {
    if (!["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"].includes(error.code)) throw error;
    folderRemoved = false;
  }
  return { root: plan.root, backup, folderRemoved };
}

export function showUninstallResult(result, print = console.log) {
  print("UNINSTALLED · local history and logs deleted; exchange orders are unchanged.");
  print(result.folderRemoved ? "Installation folder removed." : `Folder is still present (locked or new files appeared): ${result.root}`);
  print("\n\x1b[38;2;250;47;111mREINSTALL · RETURN TO YOUR HOME FOLDER\x1b[0m");
  print(process.platform === "win32" ? "In VS Code, change to your home folder or open a new installation folder before reinstalling." : 'Run: cd "$HOME"');
  if (!result.folderRemoved) print("Close terminals/editors using the old folder. It was not forcibly removed.");
}
