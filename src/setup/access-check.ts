import { PolyesterApiError } from "../polyester/transport.js";
import type { OrderPreview } from "../domain.js";

export interface AccessProbe {
  balances(): Promise<unknown>;
  orders(): Promise<unknown>;
  history(): Promise<unknown>;
  strategies(): Promise<unknown>;
  preview(): Promise<OrderPreview>;
}
export interface AccessResult { ok: boolean; hint: string }
export interface AccessReport { ok: boolean; balances: AccessResult; trading: AccessResult }

export function explainAccessError(error: unknown): string {
  if (!(error instanceof PolyesterApiError)) return "Could not complete the check. Check your connection and API configuration, then retry.";
  const code = (error.code ?? "").toUpperCase();
  if (code === "SIGNATURE_INVALID") return "Signature rejected. API Key ID and private Ed25519 seed must belong to the same key. Choose 2 to replace them.";
  if (code.includes("TIMESTAMP") || code.includes("REPLAY")) return "Check your computer's date and time, then retry.";
  if (code.includes("IP_") || code.includes("WHITELIST")) return "Your IP may not be allowed. Check the API key IP allowlist.";
  if (error.status === 401) return "Authentication failed. Check that the API key is active, has not expired, and matches the private seed.";
  if (code.includes("POLICY") || code.includes("PERMISSION") || error.status === 403) return "Access denied. Check the API key permissions, allowed markets and any Subaccount policy.";
  if (code.includes("BALANCE") || code.includes("FUNDS")) return "Preview rejected because of the testnet balance. Check available test assets and retry; this does not mean permissions are missing.";
  if (error.status === 429) return "API rate limit reached. Wait briefly, then press Enter to retry.";
  if (error.status === 0 || error.status >= 500) return "API temporarily unavailable. Check your connection and retry.";
  return "The API rejected this check. Review the API key, account and market settings, then retry.";
}

async function probe(action: () => Promise<unknown>): Promise<AccessResult> {
  try { await action(); return { ok: true, hint: "" }; }
  catch (error) { return { ok: false, hint: explainAccessError(error) }; }
}

export async function checkAccess(api: AccessProbe): Promise<AccessReport> {
  const balances = await probe(() => api.balances());
  const reads = await Promise.all([
    probe(() => api.orders()), probe(() => api.history()), probe(() => api.strategies())
  ]);
  let trading = reads.find(result => !result.ok) ?? { ok: true, hint: "" };
  if (trading.ok) {
    trading = await probe(async () => {
      const preview = await api.preview();
      if (!preview.admissible) {
        // A successful HTTP response can still contain a policy rejection.
        throw new PolyesterApiError("Preview rejected", 400, preview.rejectionCode);
      }
    });
  }
  return { ok: balances.ok && trading.ok, balances, trading };
}

export function renderAccessReport(report: AccessReport, readOnly = false): string {
  const reset = "\x1b[0m", green = "\x1b[38;2;70;211;105m", red = "\x1b[38;2;255;92;92m", gray = "\x1b[90m";
  const row = (label: string, result: AccessResult) => `${result.ok ? green : red}${result.ok ? "✓" : "✗"} ${label}${reset}${result.ok ? "" : `\n  ${result.hint}`}`;
  return [
    "\n\x1b[1mAPI ACCESS CHECK\x1b[0m",
    row("Balances - Read", report.balances),
    row(`Spot trading - ${readOnly ? "Read" : "Write"}`, report.trading),
    `${gray}— Transfers - None (recommended; not checked)${reset}`,
    `${gray}— Withdrawals - None (recommended; not checked)${reset}`,
    readOnly ? "Read-only mode; order placement is not checked." : "Trading is checked with a preview on one market; no order is placed.",
    report.ok ? `${green}Access check passed.${reset}` : "\nPlease check your API permissions and credentials."
  ].join("\n");
}
