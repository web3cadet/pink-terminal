import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Invoke npm's JavaScript entrypoint, never a .cmd shim. No shell quoting is needed,
// including when the installation folder or Node path contains spaces.
export function resolveNpmCli(env = process.env, execPath = process.execPath) {
  const candidates = [];
  if (env.npm_execpath) candidates.push(path.join(path.dirname(env.npm_execpath), "npm-cli.js"));
  candidates.push(path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"));
  candidates.push(path.resolve(path.dirname(execPath), "../lib/node_modules/npm/bin/npm-cli.js"));
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const bin = directory.replace(/^"|"$/g, "");
    candidates.push(path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"));
    // Homebrew, nvm and the official macOS package expose npm via a symlink.
    const npm = path.join(bin, "npm");
    if (existsSync(npm)) {
      try { const resolved = realpathSync(npm); if (path.basename(resolved) === "npm-cli.js") candidates.push(resolved); } catch { /* Try the next PATH entry. */ }
    }
  }
  const cli = candidates.find(candidate => existsSync(candidate));
  if (!cli) throw new Error("npm could not be located. Install Node.js with npm, reopen the VS Code terminal, and retry.");
  return cli;
}

export function runInstallerCommand(command, args, label, { cwd, inherit = false, env = process.env } = {}) {
  const executable = command === "npm" ? process.execPath : command;
  const commandArgs = command === "npm" ? [resolveNpmCli(env), ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd, env: { ...env }, encoding: "utf8", stdio: inherit ? "inherit" : "pipe",
    windowsHide: !inherit, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim().split(/\r?\n/).slice(-55).join("\n");
    const reason = result.error ? `${result.error.code ?? "SPAWN_ERROR"}: ${result.error.message}`
      : result.signal ? `Terminated by ${result.signal}` : `Exit code ${result.status}`;
    throw new Error(`${label} failed. ${reason}${output ? `\n\n${output}` : ""}`);
  }
  return result;
}
