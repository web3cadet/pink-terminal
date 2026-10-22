#!/usr/bin/env node

import assert from "node:assert/strict";
import { runInstallerCommand } from "./installer-process.mjs";
import { localPlatform, nodeVersionIsSupported } from "./local-platform.mjs";
import { stopBeforeInstall } from "./installation-lifecycle.mjs";
import { planUninstall, removeInstallation, showUninstallResult } from "./uninstall-files.mjs";
import { retryAccessCheck, replaceApiValues } from "./access-retry.mjs";
import { withManagementLock } from "./management-lock.mjs";
import { protectSecretFile, writeSecretFile } from "./secret-file.mjs";
import { assertUpdateTarget } from "./update-installation.mjs";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_DIR = process.cwd();
const args = new Set(process.argv.slice(2));
const LOCAL_RUN = args.has("--local") || path.resolve(SOURCE_DIR) === path.resolve(TARGET_DIR);
const FORCE_RECONFIGURE = args.has("--reconfigure");
const SELF_TEST = args.has("--self-test");
const VERIFY_INSTALL = args.has("--verify-install");
const UPDATE_ONLY = args.has("--update");
const PUBLIC_INSTALL_COMMAND = "npx --yes github:web3cadet/pink-terminal";

const color = {
  pink: "\u001b[38;2;255;47;111m",
  green: "\u001b[38;2;70;211;105m",
  cyan: "\u001b[38;2;72;199;235m",
  yellow: "\u001b[38;2;255;196;61m",
  red: "\u001b[38;2;255;92;92m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  reset: "\u001b[0m",
};

const excludedTopLevel = new Set([".env", ".git", ".runtime", "coverage", "data", "dist", "node_modules"]);

function print(message = "") { process.stdout.write(`${message}\n`); }
function fail(message) { throw new Error(message); }

function banner() {
  process.stdout.write("\u001b[2J\u001b[H");
  print(`${color.pink}${color.bold}`);
  print("  PINK TERMINAL");
  print(`${color.reset}${color.dim}  self-hosted · testnet · private · ${localPlatform().label}${color.reset}\n`);
}

function progress(percent, label) {
  const width = 32;
  const filled = Math.round((percent / 100) * width);
  const bar = `${"█".repeat(filled)}${color.dim}${"░".repeat(width - filled)}${color.reset}${color.green}`;
  print(`${color.green}[${bar}] ${String(percent).padStart(3)}%${color.reset}  ${label}`);
}

async function askLine(label, defaultValue = "") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` ${color.dim}[${defaultValue}]${color.reset}` : "";
  const value = (await rl.question(`${color.bold}${label}${color.reset}${suffix}: `)).trim();
  rl.close();
  return value || defaultValue;
}

async function askSecret(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return askLine(label);
  process.stdout.write(`${color.bold}${label}${color.reset}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  return new Promise((resolve, reject) => {
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          process.stdin.off("data", onData);
          process.stdin.setRawMode(false);
          reject(new Error("Cancelled by user."));
          return;
        }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u0008" || char === "\u007f") {
          if (value.length > 0) { value = value.slice(0, -1); process.stdout.write("\b \b"); }
          continue;
        }
        if (char >= " ") { value += char; process.stdout.write("•"); }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function choose(label, minimum, maximum) {
  while (true) {
    const value = await askLine(label);
    if (/^\d+$/.test(value) && Number(value) >= minimum && Number(value) <= maximum) return Number(value);
    print(`${color.yellow}Choose a number from ${minimum} to ${maximum}.${color.reset}`);
  }
}

function validateToken(value) { return /^\d{6,12}:[A-Za-z0-9_-]{25,}$/.test(value); }
function validateAllowedId(value) { return /^-?[1-9]\d{4,19}$/.test(value); }
function validateApiKeyId(value) { return /^ak_[A-Za-z0-9]{16,}$/.test(value); }
function normalizeSecret(value) { return value.replace(/^0x/i, ""); }
function validateSecret(value) { return /^[A-Fa-f0-9]{64}$/.test(normalizeSecret(value)); }

function renderEnvironment(config) {
  return [
    `TELEGRAM_BOT_TOKEN=${config.telegramToken}`,
    `TELEGRAM_ALLOWED_CHAT_IDS=${config.allowedId}`,
    `TELEGRAM_ALLOWED_USER_IDS=${config.allowedId}`,
    "",
    "POLYESTER_API_URL=https://api.testnet.polyester.com",
    `POLYESTER_API_KEY_ID=${config.apiKeyId}`,
    `POLYESTER_API_SECRET_HEX=${normalizeSecret(config.apiSecret)}`,
    `POLYESTER_SUBACCOUNT_ID=${config.subaccountId}`,
    "",
    "TRADING_MODE=live",
    "CONFIRMATION_TTL_SECONDS=90",
    "",
    "DATABASE_PATH=./data/polyester-bot.sqlite",
    "POLL_INTERVAL_MS=10000",
    "LOG_LEVEL=info",
    "",
  ].join("\n");
}

async function showDisclaimer() {
  print(`${color.yellow}${color.bold}BEFORE YOU CONTINUE${color.reset}\n`);
  print("Pink Terminal is an independent community project, not an official Polyester product.");
  print("LIVE mode can place and cancel signed testnet orders.");
  print("Use a dedicated API key with trading and balance permissions only — transfers");
  print("and withdrawals are not currently supported.\n");
  print(`  ${color.green}1)${color.reset} I have read this and want to continue`);
  print(`  ${color.red}2)${color.reset} Exit [bot will be uninstalled; .env backed up]`);
  print(`${color.dim}Exit removes this installation and local history, not exchange orders or other projects.${color.reset}`);
  if (await choose("Selection", 1, 2) !== 1) {
    const identified = existsSync(path.join(TARGET_DIR, "package.json")) || existsSync(path.join(TARGET_DIR, ".runtime", "install-source.json"));
    if (identified) {
      planUninstall(TARGET_DIR);
      stopBeforeInstall(TARGET_DIR, SOURCE_DIR, run);
      showUninstallResult(await removeInstallation(TARGET_DIR));
    } else {
      print("Installation cancelled. No identified bot installation was found; existing files were not changed.");
      print("You can run the installer again in this folder.");
    }
    return false;
  }
  return true;
}

function assertTargetIsSafe() {
  if (LOCAL_RUN) return;
  if (existsSync(path.join(TARGET_DIR, ".git"))) fail("This is a source Git checkout. Update it with Git; the installer will not overwrite your working tree.");
  const entries = readdirSync(TARGET_DIR).filter((name) => ![".vscode", ".env", ".DS_Store"].includes(name));
  const packageFile = path.join(TARGET_DIR, "package.json");
  const recognizedNames = new Set(["pink-terminal", "polyester-telegram-terminal"]);
  const recognized = existsSync(packageFile) && recognizedNames.has(JSON.parse(readFileSync(packageFile, "utf8")).name);
  if (entries.length > 0 && !recognized) {
    fail("Open an empty folder in VS Code before running the installer. Existing unrelated files were not changed.");
  }
}

async function copyApplication() {
  if (LOCAL_RUN) return;
  assertTargetIsSafe();
  await cp(SOURCE_DIR, TARGET_DIR, {
    recursive: true,
    force: true,
    filter(source) {
      const relative = path.relative(SOURCE_DIR, source);
      if (!relative) return true;
      const top = relative.split(path.sep)[0];
      return !excludedTopLevel.has(top);
    },
  });
}

function run(command, commandArgs, label, { inherit = false } = {}) {
  return runInstallerCommand(command, commandArgs, label, { cwd: TARGET_DIR, inherit });
}

async function fetchTelegramIdentity(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    const payload = await response.json();
    if (!response.ok || payload.ok !== true || !payload.result?.username) return null;
    return { id: payload.result.id, username: payload.result.username, url: `https://t.me/${payload.result.username}` };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function collectConfiguration() {
  print(`${color.pink}${color.bold}TELEGRAM ACCESS${color.reset}`);
  let telegramToken = "";
  let identity = null;
  while (!identity) {
    telegramToken = await askSecret("Bot token from @BotFather");
    if (!validateToken(telegramToken)) { print(`${color.yellow}That does not look like a Telegram bot token.${color.reset}`); continue; }
    print(`${color.dim}Checking the token with Telegram…${color.reset}`);
    identity = await fetchTelegramIdentity(telegramToken);
    if (!identity) print(`${color.yellow}Telegram rejected the token or could not be reached. Try again.${color.reset}`);
  }

  let allowedId = "";
  while (!validateAllowedId(allowedId)) {
    allowedId = await askLine("Allowed numeric Telegram chat/user ID");
    if (!validateAllowedId(allowedId)) print(`${color.yellow}Enter a numeric Telegram ID.${color.reset}`);
  }

  const { apiKeyId, apiSecret } = await collectApiKey();
  let subaccountId = "";
  while (true) {
    subaccountId = await askLine("Subaccount ID; press Enter for the primary account");
    if (!subaccountId || /^\d+$/.test(subaccountId)) break;
    print(`${color.yellow}Subaccount ID must be numeric or empty.${color.reset}`);
  }

  print(`\n${color.bold}READY TO LAUNCH${color.reset}`);
  print(`  Telegram bot:  ${color.cyan}@${identity.username}${color.reset}`);
  print(`  Allowed ID:    ${color.cyan}${allowedId}${color.reset}`);
  print(`  Polyester key: ${color.cyan}${apiKeyId}${color.reset}`);
  print(`  Trading mode:  ${color.green}LIVE TESTNET${color.reset}`);
  print(`  Secrets:       ${color.green}hidden · stored only in local .env${color.reset}\n`);
  print(`  ${color.green}1)${color.reset} Confirm and launch`);
  print(`  ${color.yellow}2)${color.reset} Enter again`);
  print(`  ${color.red}3)${color.reset} Exit`);
  const confirmation = await choose("Selection", 1, 3);
  if (confirmation === 2) return collectConfiguration();
  if (confirmation === 3) process.exit(0);
  return { telegramToken, allowedId, apiKeyId, apiSecret, subaccountId, identity };
}

async function collectApiKey() {
  print(`\n${color.pink}${color.bold}POLYESTER API${color.reset}`);
  let apiKeyId = "";
  while (!validateApiKeyId(apiKeyId)) {
    apiKeyId = await askLine("API Key ID (ak_…)");
    if (!validateApiKeyId(apiKeyId)) print(`${color.yellow}The API Key ID must begin with ak_.${color.reset}`);
  }
  let apiSecret = "";
  while (!validateSecret(apiSecret)) {
    apiSecret = await askSecret("Private Ed25519 seed (64 hexadecimal characters)");
    if (!validateSecret(apiSecret)) print(`${color.yellow}Expected exactly 64 hexadecimal characters.${color.reset}`);
  }
  return { apiKeyId, apiSecret: normalizeSecret(apiSecret) };
}

async function replaceApiKey() {
  const { apiKeyId, apiSecret } = await collectApiKey();
  const envFile = path.join(TARGET_DIR, ".env");
  const content = replaceApiValues(readFileSync(envFile, "utf8"), apiKeyId, apiSecret);
  await writeSecretFile(envFile, content);
  print(`${color.green}API key saved. Telegram settings and other configuration kept.${color.reset}`);
}

async function writeProtectedConfiguration(config) {
  await writeSecretFile(path.join(TARGET_DIR, ".env"), renderEnvironment(config));
  await mkdir(path.join(TARGET_DIR, "data"), { recursive: true });
  await mkdir(path.join(TARGET_DIR, ".runtime"), { recursive: true });
  await writeFile(path.join(TARGET_DIR, ".runtime", "telegram-bot.json"), `${JSON.stringify(config.identity, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(TARGET_DIR, ".runtime", "install-source.json"), `${JSON.stringify({ command: PUBLIC_INSTALL_COMMAND }, null, 2)}\n`, { mode: 0o600 });
}

async function refreshExistingTelegramIdentity() {
  await protectSecretFile(path.join(TARGET_DIR, ".env"));
  const envText = readFileSync(path.join(TARGET_DIR, ".env"), "utf8");
  const tokenLine = envText.split(/\r?\n/).find((line) => line.startsWith("TELEGRAM_BOT_TOKEN="));
  const token = tokenLine?.slice("TELEGRAM_BOT_TOKEN=".length).trim() || "";
  if (!validateToken(token)) fail("The existing .env does not contain a valid Telegram bot token. Choose reconfigure and enter it again.");
  const identity = await fetchTelegramIdentity(token);
  if (!identity) fail("Telegram rejected the existing token or could not be reached. Choose reconfigure if the token was rotated.");
  await mkdir(path.join(TARGET_DIR, "data"), { recursive: true });
  await mkdir(path.join(TARGET_DIR, ".runtime"), { recursive: true });
  await writeFile(path.join(TARGET_DIR, ".runtime", "telegram-bot.json"), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(TARGET_DIR, ".runtime", "install-source.json"), `${JSON.stringify({ command: PUBLIC_INSTALL_COMMAND }, null, 2)}\n`, { mode: 0o600 });
  return identity;
}

async function waitForStarted() {
  const stateFile = path.join(TARGET_DIR, ".runtime", localPlatform().state);
  const logFile = path.join(TARGET_DIR, ".runtime", "bot.log");
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (existsSync(logFile)) {
      const log = readFileSync(logFile, "utf8");
      if (log.includes('"message":"bot_started"')) return;
      if (log.includes('"message":"startup_failed"')) fail(`The bot rejected the configuration.\n\n${log.split(/\r?\n/).slice(-35).join("\n")}`);
    }
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      try { process.kill(Number(state.pid), 0); }
      catch { fail("The bot process stopped before it became ready. Run npm run bot:logs for details."); }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail("The bot did not reach Ready state within 45 seconds. Run npm run bot:logs for details.");
}

async function runSelfTest() {
  assert.equal(nodeVersionIsSupported("22.12.0"), false);
  assert.equal(nodeVersionIsSupported("22.13.0"), true);
  assert.equal(nodeVersionIsSupported("22.11.9"), false);
  assert.equal(validateToken(["1234567890", "abcdefghijklmnopqrstuvwxyz_ABCDE"].join(":")), true);
  assert.equal(validateAllowedId("123456789"), true); // Synthetic test ID, not an operator account.
  assert.equal(validateApiKeyId("ak_1234567890abcdef"), true);
  assert.equal(validateSecret("a".repeat(64)), true);
  const rendered = renderEnvironment({ telegramToken: "t", allowedId: "1", apiKeyId: "ak_x", apiSecret: "a".repeat(64), subaccountId: "" });
  assert.match(rendered, /TRADING_MODE=live/);
  assert.match(rendered, /POLL_INTERVAL_MS=10000/);
  run("npm", ["--version"], "npm startup self-test");
  print("Local installer self-test passed.");
}

async function main() {
  if (UPDATE_ONLY) {
    if (FORCE_RECONFIGURE || VERIFY_INSTALL || SELF_TEST || ["--stop", "--status", "--uninstall"].some(flag => args.has(flag))) fail("Update cannot be combined with other installer actions.");
    assertUpdateTarget(TARGET_DIR);
  }
  const recoveryActions = ["stop", "status", "uninstall"].filter(action => args.has("--" + action));
  if (recoveryActions.length > 1) fail("Choose one recovery action: --stop, --status or --uninstall.");
  if (recoveryActions.length === 1) {
    // Run the packaged manager, not the possibly deleted installed copy.
    // Release the launcher's cwd handle too; the child still receives TARGET_DIR.
    if (recoveryActions[0] === "uninstall") process.chdir(os.homedir());
    return run(process.execPath, [path.join(SOURCE_DIR, "scripts", "local-manager.mjs"), recoveryActions[0]], "Recovery management", { inherit: true });
  }
  if (SELF_TEST) return runSelfTest();
  localPlatform();
  if (!nodeVersionIsSupported()) fail(`Use Node.js 22.13+, 24.x or 26+. Node 22.12 lacks unflagged SQLite; Node 23 and 25 are unsupported by the test toolchain. Detected ${process.versions.node}.`);

  banner();
  if (!VERIFY_INSTALL && !UPDATE_ONLY && !await showDisclaimer()) return;
  progress(5, "Installer accepted");
  assertTargetIsSafe();
  if (!VERIFY_INSTALL) stopBeforeInstall(TARGET_DIR, SOURCE_DIR, run);
  await copyApplication();
  progress(18, "Application files ready");

  print("Installing dependencies — this may take a few minutes…");
  run("npm", ["install", "--include=dev", "--no-audit", "--no-fund"], "Dependency installation");
  progress(45, "Dependencies synchronized");
  run("npm", ["run", "check"], "Code and test validation");
  progress(60, "Type checks and tests passed");
  run("npm", ["run", "build"], "Production build");
  progress(75, "Production build ready");
  if (VERIFY_INSTALL) {
    print("Installation verification passed. No credentials read or written; no bot started.");
    return;
  }

  const envFile = path.join(TARGET_DIR, ".env");
  let keepExisting = existsSync(envFile) && !FORCE_RECONFIGURE;
  if (keepExisting && !UPDATE_ONLY) {
    print(`\n${color.yellow}Existing private configuration found.${color.reset}`);
    print(`  ${color.green}1)${color.reset} Keep it and update/relaunch`);
    print(`  ${color.yellow}2)${color.reset} Replace it using the wizard`);
    print(`  ${color.red}3)${color.reset} Exit`);
    const choice = await choose("Selection", 1, 3);
    if (choice === 2) keepExisting = false;
    if (choice === 3) process.exit(0);
  }

  let config = null;
  if (!keepExisting) {
    config = await collectConfiguration();
    await writeProtectedConfiguration(config);
  } else {
    config = { identity: await refreshExistingTelegramIdentity() };
  }
  progress(82, keepExisting ? "Existing protected configuration preserved" : "Protected local configuration saved");
  await retryAccessCheck({
    check: async () => {
      try {
        run(process.execPath, [path.join(TARGET_DIR, "dist", "tools", "setup-access-check.js")], "API access check", { inherit: true });
        return true;
      } catch { return false; }
    },
    ask: askLine, replaceKey: replaceApiKey, print
  });
  progress(94, "API access checks passed");
  run(process.execPath, [path.join(TARGET_DIR, "scripts", "local-manager.mjs"), "restart"], "Bot launch", { inherit: false });
  await waitForStarted();
  progress(100, "READY");

  let identity = config?.identity;
  if (!identity) {
    const identityFile = path.join(TARGET_DIR, ".runtime", "telegram-bot.json");
    if (existsSync(identityFile)) identity = JSON.parse(readFileSync(identityFile, "utf8"));
  }
  print(`\n${color.green}${color.bold}✓ Pink Terminal is running.${color.reset}`);
  if (identity?.url) print(`${color.bold}Open your bot:${color.reset} ${color.cyan}${identity.url}${color.reset}`);
  print(`Send ${color.bold}/start${color.reset} in Telegram.\n`);
  print(`${color.bold}Management menu:${color.reset} npm run manage`);
  print(`${color.bold}Quick restart:${color.reset}   npm run bot:restart`);
  print(`${color.bold}Status:${color.reset}          npm run bot:status`);
  print(`${color.bold}Logs:${color.reset}            npm run bot:logs`);
  print(`${color.bold}Update:${color.reset}          npm run bot:update`);
  print(`${color.dim}Updates preserve .env and local data.${color.reset}`);
}

withManagementLock(TARGET_DIR, main).catch((error) => {
  print(`\n${color.red}${color.bold}INSTALLATION FAILED${color.reset}`);
  print(`${color.red}${error instanceof Error ? error.message : String(error)}${color.reset}`);
  process.exitCode = 1;
});
