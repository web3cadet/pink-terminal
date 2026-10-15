import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramBot } from "../src/bot/bot.js";
import { AppDatabase } from "../src/storage/database.js";
import { TradingService, confirmationAccountContext } from "../src/services/trading.js";
import { Logger } from "../src/log.js";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway, OrderDraft, OrderKind, OrderSide, PairConfig } from "../src/domain.js";

const databases: AppDatabase[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.useRealTimers(); });

function setup(side: OrderSide, kind: OrderKind, mode = "live") {
  vi.useFakeTimers();
  const db = new AppDatabase(":memory:"); databases.push(db);
  const pair: PairConfig = {
    symbolId: 1, symbol: "BNB-USDT", baseAsset: "BNB", quoteAsset: "USDT", tickSize: "0.01", stepSize: "0.001",
    minQtyBase: "0.001", minNotionalQuote: "5", baseQuantityScale: 18, quoteQuantityScale: 18, referencePriceScale: 18,
    status: "PAIR_STATUS_ENABLED", defaultMarketSlippageBpsBuy: 100, defaultMarketSlippageBpsSell: 100, maxClientRefDriftBps: 100
  };
  const createOrder = vi.fn(async (_draft: OrderDraft, clientId: string) => ({ status: "accepted", clientOrderId: clientId, raw: {} }));
  const previewOrder = vi.fn(async () => ({ admissible: true, raw: {} }));
  const market = { symbolId: 1, lastPrice: "450", bestBid: "400", bestAsk: "500" };
  const gateway = {
    getCatalog: async () => ({ pairs: [pair], assets: [{ asset: "BNB", ledgerId: 1 }, { asset: "USDT", ledgerId: 2 }] }),
    listMarketOverview: async () => [market],
    listOpenOrders: async () => [],
    listBalances: async () => [{ assetId: 1, trading: "1400000000000000000", funding: "0", reserved: "0", available: "1400000000000000000" }, { assetId: 2, trading: "169814199544793805000", funding: "0", reserved: "0", available: "169814199544793805000" }],
    getSpotFeeRates: async () => ({ maker: "0.1", taker: "0.15" }), previewOrder, createOrder
  } as unknown as ExchangeGateway;
  const config = { telegramToken: "123:test", allowedChatIds: new Set([1]), allowedUserIds: new Set([1, 2]), tradingMode: mode, confirmationTtlSeconds: 90 } as AppConfig;
  const logger = new Logger("error");
  const bot = createTelegramBot({ config, gateway, database: db, trading: new TradingService(config, gateway, db, logger), logger });
  bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  let activeMessageId = 100;
  let editFailure: string | undefined;
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "editMessageText" && editFailure) {
      const description = editFailure; editFailure = undefined;
      return { ok: false, error_code: 400, description } as never;
    }
    if (method === "sendMessage") activeMessageId++;
    return { ok: true, result: { message_id: activeMessageId, date: 1, chat: { id: 1, type: "private" }, text: "panel" } } as never;
  });
  let updateId = 0;
  const callback = (data: string, user = 1) => bot.handleUpdate({ update_id: ++updateId, callback_query: { id: String(updateId), chat_instance: "1", from: { id: user, is_bot: false, first_name: "Test" }, data, message: { message_id: activeMessageId, date: 1, chat: { id: 1, type: "private" }, text: "panel" } } });
  const input = (text: string) => bot.handleUpdate({ update_id: ++updateId, message: { message_id: 200 + updateId, date: 1, chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false, first_name: "Test" }, text } });
  const command = (text: string) => bot.handleUpdate({ update_id: ++updateId, message: { message_id: 200 + updateId, date: 1, chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false, first_name: "Test" }, text, entities: [{ type: "bot_command", offset: 0, length: text.length }] } });
  const lastPanel = () => calls.filter(call => ["editMessageText", "sendMessage"].includes(call.method)).at(-1)!;
  const confirmId = () => {
    const rows = (lastPanel().payload.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard;
    return rows.flat().find(button => button.callback_data?.startsWith("confirm:o:"))!.callback_data!;
  };
  db.saveWizard(1, 1, { flow: "order", step: "kind", data: { symbolId: 1, symbol: "BNB-USDT", side } });
  const button = (label: string) => (lastPanel().payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat().find(b => b.text === label)!.callback_data;
  return { db, config, button, calls, gateway, market, previewOrder, createOrder, callback, input, command, lastPanel, confirmId, kind, failNextEdit: (description: string) => { editFailure = description; } };
}

describe("quote amount flow: inline navigation and chronological replies", () => {
  for (const side of ["BUY", "SELL"] as const) for (const kind of ["MARKET_IOC", "LIMIT_GTC", "LIMIT_GTD", "LIMIT_IOC", "LIMIT_FOK"] as const) {
    it(`${side} ${kind}: immediate mode waits for every required field and previews before sending`, async () => {
      const f = setup(side, kind);
      f.db.setOrderConfirmation(1, 1, confirmationAccountContext(f.config), false);
      await f.callback(`ordkind:${kind}`);
      await f.input("100");
      if (kind !== "MARKET_IOC") {
        expect(f.createOrder).not.toHaveBeenCalled();
        await f.input("250");
      }
      if (kind === "LIMIT_GTD") {
        expect(f.createOrder).not.toHaveBeenCalled();
        await f.input("60");
      }
      expect(f.previewOrder).toHaveBeenCalledOnce();
      expect(f.createOrder).toHaveBeenCalledOnce();
      expect(f.previewOrder.mock.invocationCallOrder[0]!).toBeLessThan(f.createOrder.mock.invocationCallOrder[0]!);
      expect(f.calls.some(c => String(c.payload.text).includes("<b>Confirm order</b>"))).toBe(false);
      expect(f.db.getWizard(1, 1)).toBeNull();
    });
  }
  for (const side of ["BUY", "SELL"] as const) for (const kind of ["MARKET_IOC", "LIMIT_GTC", "LIMIT_GTD", "LIMIT_IOC", "LIMIT_FOK"] as const) {
    it(`${side} ${kind}: explicit units, new replies, frozen quantity and confirmation required`, async () => {
      const f = setup(side, kind);
      await f.callback(`ordkind:${kind}`);
      expect(String(f.lastPanel().payload.text)).toContain(`Enter the amount in USDT to ${side.toLowerCase()} BNB for`);
      expect(String(f.lastPanel().payload.text)).toContain("BNB: <b>1.4</b>\nUSDT: <b>169.814199</b>");
      await f.input("100");
      if (kind !== "MARKET_IOC") {
        expect(String(f.lastPanel().payload.text)).toContain("Enter the limit price in USDT per BNB");
        await f.input("250");
      }
      if (kind === "LIMIT_GTD") await f.input("60");
      expect(f.previewOrder).toHaveBeenCalledOnce();
      const confirmation = String(f.lastPanel().payload.text);
      expect(confirmation).toContain("Confirm order");
      expect(confirmation).toContain("100 USDT");
      const qty = kind === "MARKET_IOC" ? side === "BUY" ? "0.2" : "0.25" : "0.4";
      expect(confirmation).toContain(`${qty} BNB`);
      expect(confirmation).toContain("Fee: Maker");
      expect(f.createOrder).not.toHaveBeenCalled();
      const id = f.confirmId();
      expect(f.db.getIntent(id.slice("confirm:o:".length))?.payload.qty).toBe(qty);
      // Price movement after preview must NOT silently resize the confirmed trade.
      f.market.bestBid = "100"; f.market.bestAsk = "200";
      await f.callback(id);
      expect(f.createOrder).toHaveBeenCalledOnce();
      expect(f.createOrder.mock.calls[0]![0]).toMatchObject({ qty, quoteAmount: "100", side, kind });
      expect(f.calls.filter(c => c.method === "sendMessage")).toHaveLength(kind === "MARKET_IOC" ? 2 : kind === "LIMIT_GTD" ? 4 : 3);
      expect(f.lastPanel().method).toBe("sendMessage");
      expect(f.calls.some(c => c.method === "editMessageReplyMarkup" && c.payload.message_id === 100)).toBe(true);
      expect(f.calls.some(c => String(c.payload.text).includes("Amount saved"))).toBe(false);
    });
  }
  it("replies below invalid input and insufficient funds without submitting", async () => {
    const f = setup("SELL", "MARKET_IOC");
    f.previewOrder.mockResolvedValueOnce({ admissible: false, rejectionCode: "ERROR_CODE_INSUFFICIENT_FUNDS", raw: {} } as never);
    await f.callback("ordkind:MARKET_IOC");
    await f.input("abc");
    expect(f.db.getWizard(1, 1)?.step).toBe("size");
    expect(String(f.lastPanel().payload.text)).toContain("⚠️");
    await f.input("100");
    expect(String(f.lastPanel().payload.text)).toContain("Not enough available funds to sell 0.25 BNB");
    await f.callback("order:edit:size");
    await f.input("20");
    expect(String(f.lastPanel().payload.text)).toContain("Confirm order");
    expect(String(f.lastPanel().payload.text)).toContain("0.05 BNB");
    expect(f.previewOrder).toHaveBeenCalledTimes(2);
    expect(f.calls.filter(c => c.method === "sendMessage")).toHaveLength(3);
    expect(f.createOrder).not.toHaveBeenCalled();
  });
  it("keeps token input available for selling an exact quantity", async () => {
    const f = setup("SELL", "MARKET_IOC");
    await f.callback("ordkind:MARKET_IOC");
    await f.callback("ordsize:base");
    expect(String(f.lastPanel().payload.text)).toContain("Enter the quantity of BNB to sell");
    await f.input("1,4");
    const intent = f.db.getIntent(f.confirmId().slice("confirm:o:".length))!;
    expect(intent.payload.qty).toBe("1.4");
    expect(intent.payload.quoteAmount).toBeUndefined();
    expect(intent.payload.maxQuoteDebit).toBeUndefined();
  });
  it("replaces a deleted navigation card and sends a fresh confirmation below input", async () => {
    const f = setup("BUY", "MARKET_IOC");
    f.failNextEdit("Bad Request: message to edit not found");
    await f.callback("ordkind:MARKET_IOC");
    expect(f.db.getWizard(1, 1)?.data.inputPromptId).toBe(101);
    await f.input("100");
    expect(f.lastPanel().method).toBe("sendMessage");
    expect(f.calls.filter(c => c.method === "sendMessage")).toHaveLength(2);
    expect(f.calls.some(c => c.method === "editMessageReplyMarkup" && c.payload.message_id === 101)).toBe(true);
    expect(f.createOrder).not.toHaveBeenCalled();
  });
  it("does not create an extra card if Telegram says the message is unchanged", async () => {
    const f = setup("BUY", "MARKET_IOC");
    f.failNextEdit("Bad Request: message is not modified");
    await f.callback("ordkind:MARKET_IOC");
    expect(f.db.getWizard(1, 1)?.data.inputPromptId).toBe(100);
    expect(f.calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
  });
  it("offers exactly three final actions and disables only future confirmations", async () => {
    const f = setup("BUY", "MARKET_IOC");
    await f.callback("ordkind:MARKET_IOC"); await f.input("100");
    const rows = (f.lastPanel().payload.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
    expect(rows.flat()).toHaveLength(3);
    const skip = f.button("Don't show again");
    await f.callback(skip, 2);
    expect(f.db.orderConfirmationEnabled(1, 2, confirmationAccountContext(f.config))).toBe(true);
    await f.callback(skip);
    expect(f.db.orderConfirmationEnabled(1, 1, confirmationAccountContext(f.config))).toBe(false);
    expect(f.createOrder).not.toHaveBeenCalled();
    await f.callback(f.confirmId());
    expect(f.createOrder).toHaveBeenCalledOnce();
    await f.callback("orderpairside:1:BUY"); await f.callback("ordkind:MARKET_IOC");
    expect(String(f.lastPanel().payload.text)).toContain("Final confirmation is OFF");
    await Promise.all([f.input("100"), f.input("100")]);
    expect(f.createOrder).toHaveBeenCalledTimes(2); // One first order + one immediate order, not two.
    expect(String(f.lastPanel().payload.text)).toContain("Order admitted");
    await f.callback("security:confirmation");
    await f.callback(f.button("Enable final confirmation"));
    expect(f.db.orderConfirmationEnabled(1, 1, confirmationAccountContext(f.config))).toBe(true);
    await f.callback("orderpairside:1:BUY"); await f.callback("ordkind:MARKET_IOC"); await f.input("100");
    expect(String(f.lastPanel().payload.text)).toContain("Confirm order");
    expect(f.createOrder).toHaveBeenCalledTimes(2);
  });
  it("keeps preview checks and does not retry unknown immediate submissions", async () => {
    const f = setup("SELL", "MARKET_IOC");
    await f.callback("security:confirmation"); await f.callback(f.button("Disable final confirmation"));
    await f.callback("orderpairside:1:SELL"); await f.callback("ordkind:MARKET_IOC");
    f.previewOrder.mockResolvedValueOnce({ admissible: false, rejectionCode: "ERROR_CODE_INSUFFICIENT_FUNDS", raw: {} } as never);
    await f.input("100");
    expect(f.createOrder).not.toHaveBeenCalled();
    await f.input("100"); // Not a request to retry the rejected order.
    expect(f.previewOrder).toHaveBeenCalledOnce();
    await f.callback("order:edit:size");
    f.createOrder.mockRejectedValueOnce(new Error("Connection lost after submission"));
    await f.input("100");
    expect(f.createOrder).toHaveBeenCalledOnce();
    expect(String(f.lastPanel().payload.text)).toContain("outcome is unknown");
    expect(String(f.lastPanel().payload.text)).not.toContain("No order was sent");
    expect(f.db.listUnknownOrderIntents()).toHaveLength(1);
    await f.input("100");
    expect(f.createOrder).toHaveBeenCalledOnce();
  });
  it("scopes the setting by user, chat and API configuration", () => {
    const f = setup("BUY", "MARKET_IOC");
    const context = confirmationAccountContext(f.config);
    f.db.setOrderConfirmation(1, 1, context, false);
    expect(f.db.orderConfirmationEnabled(1, 1, context)).toBe(false);
    expect(f.db.orderConfirmationEnabled(1, 2, context)).toBe(true);
    expect(f.db.orderConfirmationEnabled(2, 1, context)).toBe(true);
    expect(f.db.orderConfirmationEnabled(1, 1, confirmationAccountContext({ ...f.config, apiKeyId: "new" }))).toBe(true);
  });
  it("does not allow a disabled confirmation setting to bypass read-only mode", async () => {
    const f = setup("BUY", "MARKET_IOC", "read_only");
    f.db.setOrderConfirmation(1, 1, confirmationAccountContext(f.config), false);
    await f.callback("ordkind:MARKET_IOC"); await f.input("100");
    expect(String(f.lastPanel().payload.text)).toContain("Read-only mode");
    expect(f.previewOrder).not.toHaveBeenCalled(); expect(f.createOrder).not.toHaveBeenCalled();
  });
  it("rejects stale disable buttons without changing preferences", async () => {
    const f = setup("BUY", "MARKET_IOC");
    await f.callback("ordkind:MARKET_IOC"); await f.input("100");
    const skip = f.button("Don't show again");
    await vi.advanceTimersByTimeAsync(91_000);
    await f.callback(skip);
    expect(f.db.orderConfirmationEnabled(1, 1, confirmationAccountContext(f.config))).toBe(true);
    expect(f.createOrder).not.toHaveBeenCalled();
  });
  it("keeps result navigation inline but /menu and /start each send a fresh terminal", async () => {
    const f = setup("SELL", "MARKET_IOC");
    f.db.setOrderConfirmation(1, 1, confirmationAccountContext(f.config), false);
    await f.callback("ordkind:MARKET_IOC");
    const beforeInput = f.calls.length;
    await f.input("100");
    expect(f.calls.slice(beforeInput).filter(c => c.method === "sendMessage")).toHaveLength(1);
    expect(f.lastPanel().method).toBe("sendMessage");
    expect(String(f.lastPanel().payload.text)).toContain("Order admitted");
    await f.callback("home");
    expect(f.lastPanel().method).toBe("editMessageText");
    expect(f.lastPanel().payload.message_id).toBe(101);
    for (const command of ["/menu", "/start"]) {
      await f.command(command);
      expect(f.lastPanel().method).toBe("sendMessage");
      expect(String(f.lastPanel().payload.text)).toContain("for Polyester testnet\n🟢 Status: online");
    }
    expect(f.createOrder).toHaveBeenCalledOnce();
  });
});
