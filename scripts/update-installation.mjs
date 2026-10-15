import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runInstallerCommand } from "./installer-process.mjs";

export function formatUpdateSummary({ width = process.stdout.columns ?? 76, color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR } = {}) {
  const size = Math.max(24, Math.min(72, Math.floor(width) - 2));
  const paint = (code, text) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const wrap = (text, indent = "  ") => {
    const lines = [];
    let line = indent;
    for (const word of text.split(" ")) {
      if (line.length > indent.length && line.length + word.length + 1 > size) { lines.push(line); line = indent; }
      line += (line.length > indent.length ? " " : "") + word;
    }
    lines.push(line);
    return lines.join("\n");
  };
  return [
    "", paint("1;38;2;255;47;111", "PINK TERMINAL / UPDATE"), paint("90", "─".repeat(size)), "",
    paint("1;38;2;72;199;235", "  LATEST BUILD"),
    wrap("Download GitHub main. Replace application files and dependencies."), "",
    paint("1;38;2;70;211;105", "  YOUR DATA STAYS"),
    wrap("Keep .env, local history and saved settings."), "",
    paint("1", "  DURING THE UPDATE"),
    wrap("The bot stops and restarts after validation."),
    wrap("Exchange orders and strategies are not cancelled."), "",
    paint("38;2;255;196;61", wrap("Custom code edits will be replaced. Back them up first.")), "",
    paint("90", "─".repeat(size)),
    `${paint("38;2;70;211;105", "  y")}  Update now`,
    `${paint("90", "  Enter")}  Cancel`, ""
  ].join("\n");
}

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
  print(formatUpdateSummary());
  if ((await ask("Update now? [y/N]: ")).trim().toLowerCase() !== "y") { print("Update cancelled. Nothing changed."); return false; }
  await stop();
  print("\nGetting the latest build from GitHub…\n");
  try {
    run("npm", ["exec", "--yes", "--prefer-online", "--package=github:web3cadet/pink-terminal#main", "--", "pink-terminal", "--update"], "Update", { cwd: root, inherit: true });
  } catch (error) {
    throw new Error("Update did not complete. Check Status and Recent logs before starting again. Retry Update, or run the one-line installer in this folder. " + (error instanceof Error ? error.message : String(error)));
  }
  const success = "✓ Update completed";
  print(`\n${process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[1;38;2;70;211;105m${success}\u001b[0m` : success}\n  Management menu: npm run manage\n`);
  return true;
}
