import type { Logger } from "../log.js";
import { buildCanonicalString, signEd25519Hex } from "./signer.js";

export interface ApiCredentials {
  keyId: string;
  secretHex: string;
}

export class PolyesterApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "PolyesterApiError";
  }
}

interface CallOptions {
  authenticated?: boolean;
  retryRead?: boolean;
  timeoutMs?: number;
}

export class ConnectJsonTransport {
  private lastTimestamp = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly credentials: ApiCredentials | undefined,
    private readonly logger: Logger
  ) {}

  async call<T>(path: string, payload: Record<string, unknown>, options: CallOptions = {}): Promise<T> {
    const body = JSON.stringify(payload);
    const attempts = options.retryRead ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.attempt<T>(path, body, options);
      } catch (error) {
        lastError = error;
        if (!options.retryRead || !this.isRetryable(error) || attempt === attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100)));
      }
    }
    throw lastError;
  }

  private async attempt<T>(path: string, body: string, options: CallOptions): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "Accept": "application/json"
    };
    if (options.authenticated) {
      if (!this.credentials) throw new Error("Polyester API credentials are not configured");
      const timestamp = this.nextTimestamp();
      const canonical = buildCanonicalString({ timestampMs: timestamp, method: "POST", path, body });
      headers["X-API-KEY-ID"] = this.credentials.keyId;
      headers["X-API-TIMESTAMP"] = timestamp;
      headers["X-API-SIGNATURE"] = signEd25519Hex(canonical, this.credentials.secretHex);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    const started = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal
      });
      const text = await response.text();
      const parsed = text ? this.parseJson(text) : {};
      this.logger.debug("polyester_request", { path, status: response.status, durationMs: Date.now() - started });
      if (!response.ok) {
        const record = asRecord(parsed);
        throw new PolyesterApiError(
          typeof record.message === "string" ? record.message : `Polyester request failed with HTTP ${response.status}`,
          response.status,
          typeof record.code === "string" ? record.code : undefined,
          record.details
        );
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new PolyesterApiError("Polyester request timed out; outcome may be unknown", 0, "TIMEOUT");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private nextTimestamp(): string {
    const now = Date.now();
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1);
    return String(this.lastTimestamp);
  }

  private parseJson(text: string): unknown {
    try { return JSON.parse(text) as unknown; }
    catch { throw new PolyesterApiError("Polyester returned non-JSON data", 0, "INVALID_RESPONSE"); }
  }

  private isRetryable(error: unknown): boolean {
    return error instanceof PolyesterApiError && (error.status === 0 || error.status === 429 || error.status >= 500);
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
