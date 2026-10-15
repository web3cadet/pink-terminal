import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runInstallerCommand } from "./installer-process.mjs";

export function assertUpdateTarget(root) {
  const file = path.join(root, "package.json");
  const name = existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name;
  if (!["pink-terminal", "polyester-telegram-terminal"].includes(name)) throw new Error("Run Update from an existing Pink Terminal installation.");
  if (existsSync(path.join(root, ".git"))) throw new Error("This is a source Git checkout. Update it with Git; the installer will not overwrite your working tree.");
  if (!existsSync(path.join(root, ".env"))) throw new Error("Configuration is missing. Run the installation wizard first.");
}

// Called inside the platform manager's lock; npm and the fresh installer inherit it.
export async function updateInstallation(root, { stop, ask, print = console.log, run = runInstallerCommand }) {
  assertUpdateTarget(root);
  print("Update downloads the current GitHub main version and replaces application files and dependencies. .env and local data are kept. Back up custom code first.");
  print("The bot will stop during the update and restart after validation. Exchange orders and strategies are not cancelled.");
  if ((await ask("Update now? [y/N]: ")).trim().toLowerCase() !== "y") { print("Update cancelled. Nothing changed."); return false; }
  await stop();
  try {
    run("npm", ["exec", "--yes", "--prefer-online", "--package=github:web3cadet/pink-terminal#main", "--", "pink-terminal", "--update"], "Update", { cwd: root, inherit: true });
  } catch (error) {
    throw new Error("Update did not complete. Check Status and Recent logs before starting again. Retry Update, or run the one-line installer in this folder. " + (error instanceof Error ? error.message : String(error)));
  }
  print("Update completed. Reopen npm run manage to use the updated manager.");
  return true;
}
