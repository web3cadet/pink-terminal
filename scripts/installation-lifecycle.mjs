import { existsSync } from "node:fs";
import path from "node:path";

export function stopBeforeInstall(root, source, run) {
  const hasRuntime = ["windows-bot.json", "macos-bot.json"].some(name => existsSync(path.join(root, ".runtime", name)));
  if (!hasRuntime) return;
  // Use the packaged manager even if an interrupted installation lost its scripts.
  // A failed or incomplete shutdown must prevent copying files or replacing dependencies.
  run(process.execPath, [path.join(source, "scripts", "local-manager.mjs"), "stop"], "Stop before update", { inherit: true });
}
