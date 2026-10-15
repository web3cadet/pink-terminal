import { describe, it, expect, vi } from "vitest";
import { createTelegramBot } from "../src/bot/bot.js";
import { AppDatabase } from "../src/storage/database.js";
import { Logger } from "../src/log.js";
import type { ExchangeGateway } from "../src/domain.js";
import type { AppConfig } from "../src/config.js";
import type { TradingService } from "../src/services/trading.js";
import { positiveInput } from "../src/bot/presentation.js";

describe("quantity input end to end through Telegram handlers", () => {
  it("opens a reply field, accepts a decimal comma, persists quantity and renders it without writes", async () => {
    vi.useFakeTimers();
    const database = new AppDatabase(":memory:");
    const gateway = {
      getCatalog: async () => ({ pairs: [{ symbolId: 1, symbol: "HYPE-USDT", baseAsset: "HYPE", quoteAsset: "USDT", minQtyBase: "0.01", minNotionalQuote: "5" }], assets: [] }),
      listMarketOverview: async () => [], getOrderbook: async () => ({ bids: [], asks: [] }),
      getCandles: async () => [], listBalances: async () => [], listOpenOrders: async () => [],
      createOrder: vi.fn()
    } as unknown as ExchangeGateway;
    const config = { telegramToken: "123:test", allowedChatIds: new Set([1]), allowedUserIds: new Set([1]), tradingMode: "read_only", pollIntervalMs: 15000 } as AppConfig;
    const bot = createTelegramBot({ config, gateway, database, trading: {} as TradingService, logger: new Logger("error") });
    bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    let messageId = 200;
    bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: { message_id: ++messageId, date: 1, chat: { id: 1, type: "private" }, text: "test" } } as never;
    });
    database.saveWizard(1, 1, { flow: "order", step: "size", data: { symbolId: 1, symbol: "HYPE-USDT", side: "BUY", kind: "MARKET_IOC", sizingMode: "base" } });
    try {
      await bot.handleUpdate({ update_id: 1, callback_query: { id: "c1", chat_instance: "1", from: { id: 1, is_bot: false, first_name: "Test" }, data: "order:edit:size", message: { message_id: 100, date: 1, chat: { id: 1, type: "private" }, text: "panel" } } });
      expect(calls.some(c => c.method === "sendMessage" && (c.payload.reply_markup as { force_reply?: boolean })?.force_reply)).toBe(true);
      await bot.handleUpdate({ update_id: 2, message: { message_id: 300, date: 1, chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false, first_name: "Test" }, text: "1,25" } });
      expect(database.getWizard(1, 1)?.data.qty).toBe("1.25");
      expect(database.getWizard(1, 1)?.data.maxQuoteDebit).toBeUndefined();
      expect(database.getWizard(1, 1)?.step).toBe("options");
      expect(calls.some(c => c.method === "editMessageText" && String(c.payload.text).includes("1.25"))).toBe(true);
      expect(gateway.createOrder).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); database.close(); }
  });
  it("rejects invalid amounts rather than interpreting them as zero or exponent notation", () => {
    for (const value of ["0", "-1", "NaN", "1e4", "1,2,3"]) expect(() => positiveInput(value)).toThrow();
    expect(positiveInput("0,25")).toBe("0.25");
  });
  it("automatically opens one final confirmation card after a valid live amount", async () => {
    vi.useFakeTimers();
    const database = new AppDatabase(":memory:");
    const createOrder = vi.fn();
    const gateway = {
      getCatalog: async () => ({
        pairs: [{
          symbolId: 1, symbol: "HYPE-USDT", baseAsset: "HYPE", quoteAsset: "USDT",
          tickSize: "0.001", stepSize: "0.01", minQtyBase: "0.01", minNotionalQuote: "5",
          baseQuantityScale: 18, quoteQuantityScale: 18, referencePriceScale: 18,
          status: "PAIR_STATUS_ENABLED", defaultMarketSlippageBpsBuy: 100,
          defaultMarketSlippageBpsSell: 100, maxClientRefDriftBps: 100
        }],
        assets: [{ asset: "HYPE", ledgerId: 1 }, { asset: "USDT", ledgerId: 2 }], tsSec: "1"
      }),
      listMarketOverview: async () => [{ symbolId: 1, lastPrice: "82", bestBid: "81.9", bestAsk: "82.1", change24hBps: 100 }],
      getOrderbook: async () => ({ symbolId: 1, bookSeq: "1", bids: [], asks: [], ts: "1" }),
      getCandles: async () => [], listBalances: async () => [{ assetId: 1, available: "1250000000000000000" }, { assetId: 2, available: "100000000000000000000" }], listOpenOrders: async () => [], createOrder
    } as unknown as ExchangeGateway;
    const prepareOrder = vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", clientId: "tg-test", expiresAt: Date.now() + 90_000, preview: { admissible: true, raw: {} } }));
    gateway.getSpotFeeRates = async () => ({ maker: "0.1", taker: "0.15" });
    const config = {
      telegramToken: "123:test", allowedChatIds: new Set([1]), allowedUserIds: new Set([1]),
      tradingMode: "live", pollIntervalMs: 15000
    } as AppConfig;
    const bot = createTelegramBot({ config, gateway, database, trading: { prepareOrder } as unknown as TradingService, logger: new Logger("error") });
    bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    let messageId = 400;
    bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: { message_id: ++messageId, date: 1, chat: { id: 1, type: "private" }, text: "test" } } as never;
    });
    database.saveWizard(1, 1, {
      flow: "order", step: "size",
      data: { symbolId: 1, symbol: "HYPE-USDT", side: "BUY", kind: "MARKET_IOC", sizingMode: "quote", inputPromptId: 350 }
    });
    try {
      await bot.handleUpdate({
        update_id: 3,
        message: {
          message_id: 351, date: 1, chat: { id: 1, type: "private" },
          from: { id: 1, is_bot: false, first_name: "Test" }, text: "50",
          reply_to_message: { message_id: 350, date: 1, chat: { id: 1, type: "private" }, text: "Budget" }
        }
      });
      expect(prepareOrder).toHaveBeenCalledOnce();
      expect(database.getWizard(1, 1)).toBeNull();
      const confirmation = calls.find(c => c.method === "sendMessage" && String(c.payload.text).includes("Checked by Polyester"));
      expect(confirmation).toBeDefined();
      expect(String(confirmation?.payload.text)).toContain("Nothing has been sent yet");
      expect(String(confirmation?.payload.text)).toContain("Fee: Maker <b>0.1%</b> · Taker <b>0.15%</b>");
      expect(String(confirmation?.payload.text)).toContain("HYPE: <b>1.25</b> · USDT: <b>100</b>");
      expect(String(confirmation?.payload.text)).not.toContain("ORDER BOOK");
      expect(String(confirmation?.payload.text)).not.toContain("CHART");
      const rows = (confirmation?.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard;
      expect(rows.flat().some(button => button.text === "✅ Confirm BUY · 50 USDT" && button.callback_data?.startsWith("confirm:o:"))).toBe(true);
      expect(createOrder).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); database.close(); }
  });
});
