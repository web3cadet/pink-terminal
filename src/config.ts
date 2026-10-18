import "dotenv/config";
import { z } from "zod";
import type { TradingMode } from "./domain.js";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().min(1, "TELEGRAM_ALLOWED_CHAT_IDS is required"),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(""),
  POLYESTER_API_URL: z.string().url().default("https://api.testnet.polyester.com"),
  POLYESTER_API_KEY_ID: z.string().default(""),
  POLYESTER_API_SECRET_HEX: z.string().default(""),
  POLYESTER_SUBACCOUNT_ID: z.string().default(""),
  TRADING_MODE: z.enum(["paper", "read_only", "live"]).default("paper"),
  CONFIRMATION_TTL_SECONDS: z.coerce.number().int().min(15).max(600).default(90),
  DATABASE_PATH: z.string().default("./data/polyester-bot.sqlite"),
  POLL_INTERVAL_MS: z.coerce.number().int().min(10_000).max(300_000).default(15_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info")
});

function parseIdSet(value: string, field: string): Set<number> {
  const entries = value.split(",").map((item) => item.trim()).filter(Boolean);
  const ids = entries.map((item) => Number(item));
  if (ids.some((id) => !Number.isSafeInteger(id))) {
    throw new Error(`${field} must contain comma-separated integer IDs`);
  }
  return new Set(ids);
}

export interface AppConfig {
  telegramToken: string;
  allowedChatIds: Set<number>;
  allowedUserIds: Set<number>;
  apiUrl: string;
  apiKeyId?: string;
  apiSecretHex?: string;
  subaccountId?: string;
  tradingMode: TradingMode;
  confirmationTtlSeconds: number;
  databasePath: string;
  pollIntervalMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  const secret = parsed.POLYESTER_API_SECRET_HEX.replace(/^0x/i, "");
  if (secret && !/^[0-9a-fA-F]{64}$/.test(secret)) {
    throw new Error("POLYESTER_API_SECRET_HEX must be a 32-byte hex Ed25519 seed");
  }
  if (parsed.TRADING_MODE !== "paper" && (!parsed.POLYESTER_API_KEY_ID || !secret)) {
    throw new Error("Authenticated modes require POLYESTER_API_KEY_ID and POLYESTER_API_SECRET_HEX");
  }
  const result: AppConfig = {
    telegramToken: parsed.TELEGRAM_BOT_TOKEN,
    allowedChatIds: parseIdSet(parsed.TELEGRAM_ALLOWED_CHAT_IDS, "TELEGRAM_ALLOWED_CHAT_IDS"),
    allowedUserIds: parseIdSet(parsed.TELEGRAM_ALLOWED_USER_IDS, "TELEGRAM_ALLOWED_USER_IDS"),
    apiUrl: parsed.POLYESTER_API_URL.replace(/\/$/, ""),
    tradingMode: parsed.TRADING_MODE,
    confirmationTtlSeconds: parsed.CONFIRMATION_TTL_SECONDS,
    databasePath: parsed.DATABASE_PATH,
    pollIntervalMs: parsed.POLL_INTERVAL_MS,
    logLevel: parsed.LOG_LEVEL
  };
  if (parsed.POLYESTER_API_KEY_ID) result.apiKeyId = parsed.POLYESTER_API_KEY_ID;
  if (secret) result.apiSecretHex = secret;
  if (parsed.POLYESTER_SUBACCOUNT_ID) result.subaccountId = parsed.POLYESTER_SUBACCOUNT_ID;
  return result;
}
