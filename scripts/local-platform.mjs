export function localPlatform(platform = process.platform) {
  if (platform === "win32") return { label: "Windows", manager: "windows-manager.mjs", state: "windows-bot.json" };
  if (platform === "darwin") return { label: "macOS (Beta)", manager: "macos-manager.mjs", state: "macos-bot.json" };
  throw new Error("Local installation supports Windows and macOS. On Ubuntu, use install.sh and manage.sh.");
}
export function nodeVersionIsSupported(version = process.versions.node) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor] = version.split(".").map(Number);
  // node:sqlite is available without a flag starting in 22.13; Node 23/25 are excluded.
  return (major === 22 && minor >= 13) || major === 24 || major >= 26;
}
