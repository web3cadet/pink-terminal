import { describe, expect, it, vi } from "vitest";
import { createTelegramBot } from "../src/bot/bot.js";
import { AppDatabase } from "../src/storage/database.js";
import { Logger } from "../src/log.js";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway } from "../src/domain.js";
import type { TradingService } from "../src/services/trading.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
describe("single-click navigation during live updates", () => {
  it.each(["snapshot", "edit"])("keeps the selected pair visible when a previous %s is in flight", async stage => {
    vi.useFakeTimers();
    const db = new AppDatabase(":memory:");
    const gate = deferred(), entered = deferred();
    let delayNext = false;
    const overview = [{ symbolId: 1, lastPrice: "500", bestAsk: "500", bestBid: "499", change24hBps: 100 }];
    const gateway = {
      getCatalog: async () => ({ pairs: [{ symbolId: 1, symbol: "BNB-USDT", baseAsset: "BNB", quoteAsset: "USDT", status: "PAIR_STATUS_ENABLED", minQtyBase: "0.01", minNotionalQuote: "5" }], assets: [] }),
      listMarketOverview: async () => { if (delayNext && stage === "snapshot") { delayNext = false; entered.resolve(); await gate.promise; } return overview; },
      getOrderbook: async () => ({ bids: [], asks: [] }), getCandles: async () => [], listBalances: async () => []
    } as unknown as ExchangeGateway;
    const config = { telegramToken: "123:test", allowedChatIds: new Set([1]), allowedUserIds: new Set([1]), tradingMode: "live" } as AppConfig;
    const bot = createTelegramBot({ config, gateway, database: db, trading: {} as TradingService, logger: new Logger("error") });
    bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
    const applied: string[] = [];
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === "editMessageText") {
        if (delayNext && stage === "edit") { delayNext = false; entered.resolve(); await gate.promise; }
        applied.push(String((payload as { text: string }).text));
      }
      return { ok: true, result: { message_id: 100, date: 1, chat: { id: 1, type: "private" }, text: "panel" } } as never;
    });
    let updateId = 0;
    const click = (data: string) => bot.handleUpdate({ update_id: ++updateId, callback_query: { id: String(updateId), chat_instance: "1", from: { id: 1, is_bot: false, first_name: "Test" }, data, message: { message_id: 100, date: 1, chat: { id: 1, type: "private" }, text: "panel" } } });
    try {
      await click("markets:0");
      delayNext = true;
      await vi.advanceTimersByTimeAsync(1000); await entered.promise;
      const selected = click("pair:1");
      await vi.advanceTimersByTimeAsync(0);
      gate.resolve(); await selected; await vi.advanceTimersByTimeAsync(0);
      expect(applied.at(-1)).toContain("Market overview");
      expect(applied.filter(text => text.includes("Market overview"))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(applied.at(-1)).toContain("Market overview");
    } finally { gate.resolve(); vi.clearAllTimers(); vi.useRealTimers(); db.close(); }
  });
});
