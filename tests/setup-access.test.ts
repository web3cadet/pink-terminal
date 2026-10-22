import { describe, it, expect, vi } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkAccess, explainAccessError, renderAccessReport } from "../src/setup/access-check.js";
import { PolyesterApiError } from "../src/polyester/transport.js";

const probes = () => ({
  balances: vi.fn(async () => []), orders: vi.fn(async () => []),
  history: vi.fn(async () => []), strategies: vi.fn(async () => []),
  preview: vi.fn(async () => ({ admissible: true, raw: {} }))
});
const fail = (code: string, status = 403) => async () => { throw new PolyesterApiError("private response must not be printed", status, code); };
const helpers = () => import(pathToFileURL(path.resolve("scripts/access-retry.mjs")).href);

describe("setup access checks", () => {
  it("reports success without pretending to inspect transfer/withdrawal policy", async () => {
    const api = probes();
    const report = await checkAccess(api);
    expect(report.ok).toBe(true);
    const output = renderAccessReport(report);
    expect(output).toContain("✓ Balances - Read");
    expect(output).toContain("✓ Spot trading - Write");
    expect(output).toContain("— Transfers - None (recommended)");
    expect(api.preview).toHaveBeenCalledOnce();
  });
  it("distinguishes bad signature from missing permissions and hides server messages", async () => {
    const api = { ...probes(), balances: fail("SIGNATURE_INVALID", 401), orders: fail("SIGNATURE_INVALID", 401) };
    const report = await checkAccess(api);
    expect(report.ok).toBe(false);
    expect(report.balances.hint).toContain("must belong to the same key");
    expect(renderAccessReport(report)).not.toContain("private response");
    expect(api.preview).not.toHaveBeenCalled();
  });
  it("reports denied balances independently from granted trading", async () => {
    const report = await checkAccess({ ...probes(), balances: fail("PERMISSION_DENIED") });
    expect(report.balances.ok).toBe(false);
    expect(report.trading.ok).toBe(true);
    expect(report.ok).toBe(false);
  });
  it("does not accept a policy rejection inside a successful preview response", async () => {
    const report = await checkAccess({ ...probes(), preview: async () => ({ admissible: false, rejectionCode: "POLICY_DENIED", raw: {} }) });
    expect(report.trading.ok).toBe(false);
    expect(report.trading.hint).toContain("permissions");
  });
  it("explains network, balance, IP and timestamp errors without exposing secrets", () => {
    expect(explainAccessError(new PolyesterApiError("secret", 0, "TIMEOUT"))).toContain("temporarily unavailable");
    expect(explainAccessError(new PolyesterApiError("secret", 400, "INSUFFICIENT_BALANCE"))).toContain("testnet balance");
    expect(explainAccessError(new PolyesterApiError("secret", 403, "IP_NOT_ALLOWED"))).toContain("allowlist");
    expect(explainAccessError(new PolyesterApiError("secret", 401, "TIMESTAMP_SKEW"))).toContain("date and time");
  });
  it("Enter retries until success; option 2 replaces only the API key without rerunning setup", async () => {
    const { retryAccessCheck } = await helpers();
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ask = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("invalid").mockResolvedValueOnce("2");
    const replaceKey = vi.fn(async () => {});
    await retryAccessCheck({ check, ask, replaceKey, print: vi.fn() });
    expect(check).toHaveBeenCalledTimes(3);
    expect(replaceKey).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledTimes(3);
  });
  it("API replacement preserves Telegram, account scope, mode and custom values", async () => {
    const { replaceApiValues } = await helpers();
    const existing = "# private settings\nTELEGRAM_BOT_TOKEN=fixture\nTELEGRAM_ALLOWED_CHAT_IDS=123456\nPOLYESTER_SUBACCOUNT_ID=42\nTRADING_MODE=live\nCUSTOM=value\nPOLYESTER_API_KEY_ID=old\nPOLYESTER_API_SECRET_HEX=old\n";
    const changed = replaceApiValues(existing, "ak_1234567890abcdef", "a".repeat(64));
    expect(changed).toBe(existing.replace("POLYESTER_API_KEY_ID=old", "POLYESTER_API_KEY_ID=ak_1234567890abcdef").replace("POLYESTER_API_SECRET_HEX=old", `POLYESTER_API_SECRET_HEX=${"a".repeat(64)}`));
    expect(() => replaceApiValues(existing, "bad\nkey", "a".repeat(64))).toThrow();
  });
  it("the real check process rereads edited .env on retry and safely explains HTTP 401", async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      const publicRead = req.url?.endsWith("GetSpotConfig");
      const accepted = publicRead || req.headers["x-api-key-id"] === "ak_1234567890abcdef";
      res.writeHead(accepted ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(accepted ? {} : { code: "SIGNATURE_INVALID", message: "DO_NOT_PRINT_SERVER_MESSAGE" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture server");
    const root = mkdtempSync(path.join(tmpdir(), "Pink access retry "));
    const envFile = path.join(root, ".env");
    const seed = "b".repeat(64);
    const envText = `TELEGRAM_BOT_TOKEN=fixture\nTELEGRAM_ALLOWED_CHAT_IDS=123456\nPOLYESTER_API_URL=http://127.0.0.1:${address.port}\nPOLYESTER_API_KEY_ID=ak_wrong1234567890\nPOLYESTER_API_SECRET_HEX=${seed}\nTRADING_MODE=read_only\n`;
    writeFileSync(envFile, envText);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TELEGRAM_|POLYESTER_|TRADING_MODE$|DOTENV_CONFIG_)/.test(key)));
    const check = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("src/tools/setup-access-check.ts")], { cwd: root, env, windowsHide: true });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.on("error", reject);
      child.on("close", code => resolve({ code, output }));
    });
    try {
      const first = await check();
      expect(first.code).toBe(1);
      expect(first.output).toContain("Signature rejected");
      expect(first.output).not.toContain("DO_NOT_PRINT_SERVER_MESSAGE");
      expect(first.output).not.toContain(seed);
      const { replaceApiValues } = await helpers();
      writeFileSync(envFile, replaceApiValues(envText, "ak_1234567890abcdef", seed));
      const second = await check();
      expect(second.code, second.output).toBe(0);
      expect(second.output).toContain("Access check passed");
      expect(requests.some(url => /Create|Cancel|Transfer|Withdraw/.test(url))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
