import { describe, expect, it, vi } from "vitest";
import { createTelegramBot } from "../src/bot/bot.js";
import { AppDatabase } from "../src/storage/database.js";
import { Logger } from "../src/log.js";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway } from "../src/domain.js";
import type { TradingService } from "../src/services/trading.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
describe("single-click navigation during live updates", () => {
  it.each(["real chart", "one-second refresh", "snapshot", "edit", "slow data", "unchanged", "fast data", "slow acknowledgement", "expired acknowledgement", "cached buy balance", "cached sell balance", "slow buy balance", "slow sell balance", "duplicate buy", "duplicate sell", "wizard buy", "wizard sell", "navigation order"])("handles %s without needing a second click", async stage => {
    vi.useFakeTimers();
    const db = new AppDatabase(":memory:");
    const gate = deferred(), entered = deferred();
    let delayNext = false;
    const overview = [{ symbolId: 1, lastPrice: "500", bestAsk: "500", bestBid: "499", change24hBps: 100 }];
    const getCandles = vi.fn(async (_symbolId: number, timeframe: string, _count: number) => {
      if (stage === "slow data") { entered.resolve(); await gate.promise; }
      return stage === "real chart" ? [3, 1, 4, 2].map(tsSec => ({ tsSec: String(tsSec), close: String(timeframe === "5m" ? 5 - tsSec : tsSec) })) : [];
    });
    const listBalances = vi.fn(async () => {
      if (delayNext && /balance|duplicate/.test(stage)) { entered.resolve(); await gate.promise; }
      return [];
    });
    const gateway = {
      getCatalog: async () => ({ pairs: [{ symbolId: 1, symbol: "BNB-USDT", baseAsset: "BNB", quoteAsset: "USDT", status: "PAIR_STATUS_ENABLED", minQtyBase: "0.01", minNotionalQuote: "5" }], assets: [{ asset: "BNB", ledgerId: 1 }, { asset: "USDT", ledgerId: 2 }] }),
      listMarketOverview: async () => { if (delayNext && stage === "snapshot") { delayNext = false; entered.resolve(); await gate.promise; } return overview; },
      getOrderbook: async () => ({ bids: [], asks: [] }), getCandles, listBalances
    } as unknown as ExchangeGateway;
    const config = { telegramToken: "123:test", allowedChatIds: new Set([1]), allowedUserIds: new Set([1]), tradingMode: "live" } as AppConfig;
    const bot = createTelegramBot({ config, gateway, database: db, trading: {} as TradingService, logger: new Logger("error") });
    bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
    const applied: string[] = [];
    const acknowledgements: string[] = [];
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === "answerCallbackQuery") {
        acknowledgements.push(String((payload as { callback_query_id: string }).callback_query_id));
        if (delayNext && (stage === "slow acknowledgement" || stage === "navigation order")) { delayNext = false; entered.resolve(); await gate.promise; }
        if (delayNext && stage === "expired acknowledgement") return { ok: false, error_code: 400, description: "Bad Request: query is too old and response timeout expired" } as never;
      }
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
      if (stage === "real chart") {
        for (const timeframe of ["1m", "5m", "1h", "4h"]) {
          await click(`pairtf:1:${timeframe}`);
          expect(getCandles).toHaveBeenLastCalledWith(1, timeframe, 32);
          expect(applied.at(-1)).toContain(`💗 CHART · ${timeframe}`);
          expect(applied.at(-1)).toContain(timeframe === "5m" ? "█▆▃▁" : "▁▃▆█");
        }
        return;
      }
      if (stage === "one-second refresh") {
        expect(applied[0]).toContain("Refresh: 1s");
        overview[0]!.lastPrice = "501";
        await vi.advanceTimersByTimeAsync(999);
        expect(applied).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(applied).toHaveLength(2);
        expect(applied.at(-1)).toContain("$501");
        return;
      }
      if (stage === "navigation order") {
        delayNext = true;
        const pair = click("pair:1");
        await entered.promise;
        const side = click("orderpairside:1:SELL");
        await vi.advanceTimersByTimeAsync(0);
        gate.resolve(); await Promise.all([pair, side]);
        expect(applied.at(-1)).toContain("Order type");
        expect(db.getWizard(1, 1)?.data.side).toBe("SELL");
        return;
      }
      if (stage.startsWith("wizard")) {
        await click("ordpair:1");
        expect(applied.at(-1)).toContain("New order");
        await click(`ordside:${stage.endsWith("buy") ? "BUY" : "SELL"}`);
        expect(applied.at(-1)).toContain("Order type");
        expect(listBalances).toHaveBeenCalledOnce();
        return;
      }
      if (stage.startsWith("duplicate")) {
        delayNext = true;
        const data = `orderpairside:1:${stage.endsWith("buy") ? "BUY" : "SELL"}`;
        const selected = click(data);
        await entered.promise;
        await click(data);
        expect(listBalances).toHaveBeenCalledOnce();
        expect(acknowledgements).toEqual(["1", "2", "3"]);
        gate.resolve(); await selected;
        expect(applied.filter(text => text.includes("Order type"))).toHaveLength(1);
        return;
      }
      if (stage === "slow acknowledgement") {
        delayNext = true;
        const selected = click("pair:1");
        await entered.promise; await vi.advanceTimersByTimeAsync(0);
        const firstClickRendered = applied.at(-1)?.includes("Market overview");
        gate.resolve(); await selected;
        expect(firstClickRendered).toBe(true);
        return;
      }
      if (stage === "expired acknowledgement") {
        delayNext = true;
        await click("orderpairside:1:BUY");
        expect(applied.at(-1)).toContain("Order type");
        return;
      }
      if (stage.includes("balance")) {
        await click("pair:1");
        if (stage.startsWith("slow")) await vi.advanceTimersByTimeAsync(6000);
        delayNext = true;
        const selected = click(`orderpairside:1:${stage.includes("buy") ? "BUY" : "SELL"}`);
        await vi.advanceTimersByTimeAsync(1100);
        const firstClickRendered = applied.at(-1)?.includes("Order type");
        const reads = listBalances.mock.calls.length;
        gate.resolve(); await selected;
        expect(firstClickRendered).toBe(true);
        expect(reads).toBe(stage.startsWith("cached") ? 1 : 2);
        return;
      }
      if (stage === "fast data") {
        await click("pair:1");
        expect(applied.filter(text => text.includes("Opening market"))).toHaveLength(0);
        expect(applied.filter(text => text.includes("Market overview"))).toHaveLength(1);
        return;
      }
      if (stage === "slow data") {
        const selected = click("pair:1");
        await entered.promise; await vi.advanceTimersByTimeAsync(350);
        expect(applied.at(-1)).toContain("Opening market");
        expect(listBalances).toHaveBeenCalledOnce(); // Balance loads alongside the slow chart, not after it.
        await click("pair:1"); // A duplicate tap is acknowledged, but must not enqueue another fetch.
        expect(getCandles).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(3100); await selected;
        expect(applied.at(-1)).toContain("Market overview");
        expect(applied.at(-1)).toContain("Chart unavailable");
        expect(applied.at(-1)).toContain("500 USDT");
        const count = applied.length;
        gate.resolve(); await vi.advanceTimersByTimeAsync(0);
        expect(applied).toHaveLength(count); // Late data must not overwrite a newer screen.
        return;
      }
      if (stage === "unchanged") {
        await vi.advanceTimersByTimeAsync(15000);
        expect(applied).toHaveLength(1); // A clock tick alone no longer edits the market list.
        return;
      }
      delayNext = true;
      overview[0]!.lastPrice = "501";
      await vi.advanceTimersByTimeAsync(5000); await entered.promise;
      const selected = click("pair:1");
      await vi.advanceTimersByTimeAsync(0);
      expect(acknowledgements).toContain("2"); // Even while an earlier Telegram edit is pending.
      gate.resolve(); await selected; await vi.advanceTimersByTimeAsync(0);
      expect(applied.at(-1)).toContain("Market overview");
      expect(applied.filter(text => text.includes("Market overview"))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(applied.at(-1)).toContain("Market overview");
    } finally { gate.resolve(); vi.clearAllTimers(); vi.useRealTimers(); db.close(); }
  });
});
