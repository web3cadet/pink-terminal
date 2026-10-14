import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const names = JSON.parse(readFileSync(new URL("./uninstall-files.json", import.meta.url), "utf8"));

export function planUninstall(directory) {
  const root = realpathSync(directory);
  if (lstatSync(path.resolve(directory)).isSymbolicLink() || root === path.parse(root).root || root === realpathSync(os.homedir())) {
    throw new Error("Refusing uninstall from a linked or broad directory.");
  }
  const packageFile = path.join(root, "package.json");
  if (lstatSync(packageFile).isSymbolicLink() || JSON.parse(readFileSync(packageFile, "utf8")).name !== "pink-terminal") {
    throw new Error("Not a Pink Terminal installation.");
  }
  if (existsSync(path.join(root, ".git"))) throw new Error("Uninstall is disabled in a source Git checkout. Use a dedicated installed copy.");
  const targets = names.map(name => path.join(root, name)).filter(file => existsSync(file));
  for (const file of targets) {
    if (path.basename(file).toLowerCase() === ".env" || path.dirname(file) !== root || lstatSync(file).isSymbolicLink() || realpathSync(file) !== file) {
      throw new Error("Refusing uninstall: linked or out-of-folder target.");
    }
  }
  return { root, targets };
}

export function removeInstallation(directory) {
  // Revalidate immediately before deleting; never remove the containing folder or .env.
  const plan = planUninstall(directory);
  for (const file of plan.targets) rmSync(file, { recursive: true, force: true });
}
