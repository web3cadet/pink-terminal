import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway, PairConfig, TriggerDraft } from "../src/domain.js";
import { Logger } from "../src/log.js";
import { PolyesterGateway } from "../src/polyester/gateway.js";
import { createTelegramBot } from "../src/bot/bot.js";
import { AppDatabase } from "../src/storage/database.js";
import type { TradingService } from "../src/services/trading.js";

const pair: PairConfig = {
  symbolId: 1, symbol: "DOGE-USDT", baseAsset: "DOGE", quoteAsset: "USDT",
  tickSize: "0.0001", stepSize: "1", minNotionalQuote: "5", minQtyBase: "1",
  baseQuantityScale: 8, quoteQuantityScale: 6, referencePriceScale: 8,
  status: "PAIR_STATUS_ENABLED", defaultMarketSlippageBpsBuy: 100,
  defaultMarketSlippageBpsSell: 100, maxClientRefDriftBps: 100
};

describe("ladder strategy flow", () => {
  it("builds a Polyester ladder request without an unrelated child limit price", async () => {
    const config = { apiUrl: "https://api.testnet.polyester.com" } as AppConfig;
    const gateway = new PolyesterGateway(config, new Logger("error"));
    gateway.getCatalog = async () => ({ pairs: [pair], assets: [], tsSec: "1" });
    const call = vi.fn(async (_path: string, payload: Record<string, unknown>) => payload);
    (gateway as unknown as { transport: { call: typeof call } }).transport.call = call;

    const draft: TriggerDraft = {
      symbolId: 1, symbol: "DOGE-USDT", kind: "LADDER", side: "BUY", qty: "100",
      priceMin: "0.5", priceMax: "0.9", levels: 10,
      childKind: "LIMIT_GTC", postOnly: true
    };
    await expect(gateway.createTrigger(draft, "tr-test")).resolves.toBeDefined();
    const payload = call.mock.calls[0]?.[1] as { trigger: Record<string, unknown> };
    expect(payload.trigger).toHaveProperty("ladder");
    expect(payload.trigger).not.toHaveProperty("child");
  });

  it("goes directly from the final levels value to one activation confirmation", async () => {
    const database = new AppDatabase(":memory:");
    const gateway = { createTrigger: vi.fn() } as unknown as ExchangeGateway;
    const prepareTrigger = vi.fn(async (_chatId: number, _userId: number, draft: TriggerDraft) => ({
      id: "22222222-2222-4222-8222-222222222222", clientId: "tr-test",
      expiresAt: Date.now() + 90_000, draft
    }));
    const config = {
      telegramToken: "123:test", allowedChatIds: new Set([1]), allowedUserIds: new Set([1]),
      tradingMode: "live", confirmationTtlSeconds: 90, pollIntervalMs: 15_000
    } as AppConfig;
    const bot = createTelegramBot({
      config, gateway, database,
      trading: { prepareTrigger } as unknown as TradingService,
      logger: new Logger("error")
    });
    bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: { message_id: 500, date: 1, chat: { id: 1, type: "private" }, text: "test" } } as never;
    });
    database.saveWizard(1, 1, {
      flow: "trigger", step: "tr_levels",
      data: { symbolId: 1, symbol: "DOGE-USDT", kind: "LADDER", side: "BUY", qty: "100", priceMin: "0.5", priceMax: "0.9" }
    });

    try {
      await bot.handleUpdate({
        update_id: 1,
        message: { message_id: 400, date: 1, chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false, first_name: "Test" }, text: "10" }
      });
      expect(prepareTrigger).toHaveBeenCalledOnce();
      const draft = prepareTrigger.mock.calls[0]?.[2];
      expect(draft).toMatchObject({ kind: "LADDER", levels: 10, childKind: "LIMIT_GTC", postOnly: true });
      expect(draft?.childLimitPrice).toBeUndefined();
      expect(database.getWizard(1, 1)).toBeNull();
      const confirmation = calls.find(item => ["sendMessage", "editMessageText"].includes(item.method) && String(item.payload.text).includes("Strategy is ready"));
      expect(confirmation).toBeDefined();
      expect(String(confirmation?.payload.text)).not.toContain("Child:");
      expect(String(confirmation?.payload.text)).toContain("10 resting limit orders");
      const rows = (confirmation?.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard;
      expect(rows.flat().some(button => button.text === "✅ Confirm & activate" && button.callback_data?.startsWith("confirm:t:"))).toBe(true);
      expect(gateway.createTrigger).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});
