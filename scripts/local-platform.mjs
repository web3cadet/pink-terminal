export function localPlatform(platform = process.platform) {
  if (platform === "win32") return { label: "Windows", manager: "windows-manager.mjs", state: "windows-bot.json" };
  if (platform === "darwin") return { label: "macOS (Beta)", manager: "macos-manager.mjs", state: "macos-bot.json" };
  throw new Error("Local installation supports Windows and macOS. On Ubuntu, use install.sh and manage.sh.");
}
