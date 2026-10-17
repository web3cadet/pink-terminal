import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway, TriggerDraft, PairConfig } from "../src/domain.js";
import { createTelegramBot } from "../src/bot/bot.js";
import { TradingService } from "../src/services/trading.js";
import { AppDatabase } from "../src/storage/database.js";
import { Logger } from "../src/log.js";

function fixture() {
  const db = new AppDatabase(":memory:");
  const pair = { symbolId: 17, symbol: "ETC-USDT", status: "PAIR_STATUS_ENABLED", minQtyBase: "0.1", minNotionalQuote: "5", tickSize: "0.001", stepSize: "0.000001", baseAsset: "ETC", quoteAsset: "USDT" } as PairConfig;
  const createTrigger = vi.fn(async (_draft: TriggerDraft, clientTriggerId: string) => ({ triggerId: "123", clientTriggerId }));
  const gateway = { getCatalog: async () => ({ pairs: [pair], assets: [], tsSec: "0" }), getOrderDetails: async () => null, createTrigger } as unknown as ExchangeGateway;
  const config = { telegramToken: "123:test", allowedChatIds: new Set([1]), allowedUserIds: new Set([1]), tradingMode: "live", confirmationTtlSeconds: 90 } as AppConfig;
  const logger = new Logger("error");
  const bot = createTelegramBot({ config, gateway, database: db, trading: new TradingService(config, gateway, db, logger), logger });
  bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
  const panels: Record<string, any>[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage" || method === "editMessageText") panels.push(payload);
    return { ok: true, result: { message_id: 100, date: 1, chat: { id: 1, type: "private" }, text: "panel" } } as never;
  });
  let id = 0;
  const from = { id: 1, is_bot: false, first_name: "Test" };
  const chat = { id: 1, type: "private" as const };
  const callback = (data: string) => bot.handleUpdate({ update_id: ++id, callback_query: { id: String(id), chat_instance: "1", from, data, message: { message_id: 100, date: 1, chat, text: "panel" } } });
  const input = (text: string) => bot.handleUpdate({ update_id: ++id, message: { message_id: 200 + id, date: 1, chat, from, text } });
  return { db, createTrigger, callback, input, panels };
}

describe("complete Telegram strategy wizard", () => {
  it("lets an invalid ladder be corrected without submitting it", async () => {
    const f = fixture();
    try {
      await f.callback("trigger:new"); await f.callback("trpair:17"); await f.callback("trkind:LADDER"); await f.callback("trside:BUY");
      await f.input("1.627237"); await f.input("8"); await f.input("9"); await f.input("2");
      expect(f.panels.at(-1)?.text).toContain("multiple of 0.000002");
      expect(f.createTrigger).not.toHaveBeenCalled();
      await f.callback("tredit");
      await f.input("1.627236"); await f.input("8"); await f.input("9"); await f.input("2");
      expect(f.panels.at(-1)?.text).toContain("Confirm strategy");
      expect(f.createTrigger).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it("keeps a refresh button when a newly admitted order is not indexed yet", async () => {
    const f = fixture();
    try {
      await f.callback("od:pending");
      expect(f.panels.at(-1)?.text).toContain("Order details pending");
      expect(f.panels.at(-1)?.reply_markup.inline_keyboard.flat()).toContainEqual({ text: "↻ Refresh order", callback_data: "od:pending" });
      expect(f.createTrigger).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  for (const kind of ["STOP_LOSS", "TAKE_PROFIT", "TRAILING_STOP", "TWAP", "LADDER"] as const) {
    for (const side of ["BUY", "SELL"] as const) {
      if (kind === "TRAILING_STOP" && side === "BUY") continue;
      const children = kind === "LADDER" ? ["LIMIT_GTC"] as const : kind === "TRAILING_STOP" || ((kind === "STOP_LOSS" || kind === "TAKE_PROFIT") && side === "BUY") ? [kind === "TRAILING_STOP" ? "MARKET_IOC" : "LIMIT_GTC"] as const : ["MARKET_IOC", "LIMIT_GTC"] as const;
      for (const childKind of children) it(`${kind} ${side} ${childKind}: every button/input reaches one confirmed write`, async () => {
        const f = fixture();
        try {
          await f.callback("trigger:new"); await f.callback("trpair:17"); await f.callback(`trkind:${kind}`);
          if (kind !== "TRAILING_STOP") await f.callback(`trside:${side}`);
          await f.input("2");
          if (kind === "STOP_LOSS" || kind === "TAKE_PROFIT") await f.input("8");
          if (kind === "TWAP") { await f.input("4"); await f.input("2"); }
          if (kind === "LADDER") { await f.input("8"); await f.input("9"); await f.input("2"); }
          else if (kind === "TRAILING_STOP") { await f.input("100"); await f.input("0"); await f.input("100"); }
          else { await f.callback(`trchild:${childKind}`); if (childKind === "LIMIT_GTC") await f.input("8"); }
          expect(f.createTrigger).not.toHaveBeenCalled();
          expect(f.panels.at(-1)?.text).toContain("Confirm strategy");
          const button = f.panels.at(-1)?.reply_markup.inline_keyboard.flat().find((b: any) => b.callback_data?.startsWith("confirm:t:"));
          expect(button).toBeDefined();
          await f.callback(button.callback_data);
          expect(f.createTrigger).toHaveBeenCalledOnce();
          expect(f.createTrigger.mock.calls[0]?.[0]).toMatchObject({ kind, side, childKind, qty: "2" });
          await expect(f.callback(button.callback_data)).rejects.toThrow(/no longer valid/);
          expect(f.createTrigger).toHaveBeenCalledOnce();
        } finally { f.db.close(); }
      });
    }
  }
});
