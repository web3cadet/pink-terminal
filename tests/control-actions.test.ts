import { describe, it, expect, vi } from "vitest";
import { createTelegramBot } from "../src/bot/bot.js";
import { AppDatabase, type ControlAction } from "../src/storage/database.js";
import { confirmationAccountContext } from "../src/services/trading.js";
import type { TradingService } from "../src/services/trading.js";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway } from "../src/domain.js";
import { Logger } from "../src/log.js";

const config: AppConfig = {
  telegramToken: "123:test", allowedChatIds: new Set([1, 2]), allowedUserIds: new Set([1, 2]),
  apiUrl: "https://api.testnet.polyester.com", apiKeyId: "ak_fixture", apiSecretHex: "11".repeat(32),
  tradingMode: "live", confirmationTtlSeconds: 90, databasePath: ":memory:", pollIntervalMs: 15000, logLevel: "error"
};
function fixture(database = new AppDatabase(":memory:"), settings = config) {
  const writes = { cancelOrder: vi.fn(), cancelTrigger: vi.fn(), pauseTrigger: vi.fn(), resumeTrigger: vi.fn(), cancelAll: vi.fn(async () => ({ count: 1 })) };
  const gateway = {
    ...writes,
    getCatalog: async () => ({ pairs: [], assets: [] }),
    listOpenOrders: async () => [{ symbolId: 1, orderId: "order", clientOrderId: "client", side: "BUY", status: "OPEN", raw: {} }],
    listOrderHistory: async () => [],
    listTriggers: async () => [{ symbolId: 1, triggerId: "trigger", type: "TWAP", status: "ACTIVE", raw: {} }]
  } as unknown as ExchangeGateway;
  const bot = createTelegramBot({ config: settings, gateway, database, trading: {} as TradingService, logger: new Logger("error") });
  bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
  const calls: { method: string; payload: any }[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: 100, date: 1, chat: { id: 1, type: "private" }, text: "fixture" } } as never;
  });
  let updateId = 0;
  const click = (data: string, user = 1, chat = 1) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
    id: String(updateId), chat_instance: String(chat), from: { id: user, is_bot: false, first_name: "Test" }, data,
    message: { message_id: 100, date: 1, chat: { id: chat, type: "private" }, text: "fixture" }
  } });
  const button = (text: string): string => {
    const buttons = calls.flatMap(c => c.payload.reply_markup?.inline_keyboard?.flat() ?? []);
    const data = buttons.filter((b: any) => b.text === text).at(-1)?.callback_data;
    expect(typeof data).toBe("string");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    return data;
  };
  return { database, click, button, calls, writes };
}

describe("account-bound control buttons", () => {
  it("cancels an order once, using an owner-bound confirmation", async () => {
    const f = fixture();
    try {
      await f.click("orders:open");
      await f.click(f.button("Cancel order"));
      const confirm = f.button("Confirm cancellation");
      await f.click(confirm, 2);
      await f.click(confirm, 1, 2);
      expect(f.writes.cancelOrder).not.toHaveBeenCalled();
      await Promise.all([f.click(confirm), f.click(confirm)]);
      expect(f.writes.cancelOrder).toHaveBeenCalledExactlyOnceWith("client", 1);
    } finally { f.database.close(); }
  });

  it("keeps orders when Keep is selected and rejects expired confirmations", async () => {
    const f = fixture();
    try {
      await f.click("oca:preview");
      const old = f.button("Confirm · cancel all");
      await f.click("orders:open");
      await f.click(old);
      await f.click("oca:preview");
      const expired = f.button("Confirm · cancel all");
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 91000);
      try { await f.click(expired); } finally { clock.mockRestore(); }
      expect(f.writes.cancelAll.mock.calls.every((args: any[]) => args[1] === true)).toBe(true);
    } finally { f.database.close(); }
  });

  it("submits cancel-all once and never reuses the old wizard", async () => {
    const f = fixture();
    try {
      f.database.saveWizard(1, 1, { flow: "cancel_all", step: "confirm", data: { requestId: "legacy" } });
      await f.click("oca:confirm");
      expect(f.writes.cancelAll).not.toHaveBeenCalled();
      await f.click("oca:preview");
      const confirm = f.button("Confirm · cancel all");
      await f.click(confirm);
      await f.click(confirm);
      expect(f.writes.cancelAll.mock.calls.filter((args: any[]) => args[1] === false)).toHaveLength(1);
    } finally { f.database.close(); }
  });

  it.each(["cancel_order_prompt", "cancel_order", "cancel_trigger_prompt", "cancel_trigger", "pause_trigger", "resume_trigger", "cancel_all"] as const)("rejects %s after API-key change, without writes or a new confirmation", async kind => {
    const f = fixture();
    const id = "00000000-0000-4000-a000-000000000001";
    f.database.createControlAction(id, 1, 1, confirmationAccountContext(config), { kind, targetId: "fixture", symbolId: 1 }, Date.now() + 90000);
    const other = fixture(f.database, { ...config, apiKeyId: "ak_other" });
    try {
      await other.click(`ctl:${id}`);
      for (const write of Object.values(other.writes)) expect(write).not.toHaveBeenCalled();
      expect(other.calls.at(-1)?.payload.text).toContain("expired");
    } finally { f.database.close(); }
  });

  it.each(["oc:1:x", "occ:1:x", "tp:1:x", "tr:1:x", "tc:1:x", "tcc:1:x", "oca:confirm"])("rejects legacy callback %s", async data => {
    const f = fixture();
    try {
      await f.click(data);
      for (const write of Object.values(f.writes)) expect(write).not.toHaveBeenCalled();
      expect(f.calls.at(-1)?.payload.show_alert).toBe(true);
    } finally { f.database.close(); }
  });

  it("pauses, resumes and cancels strategies with single-use controls", async () => {
    const f = fixture();
    try {
      await f.click("td:trigger");
      const pause = f.button("Pause");
      await f.click(pause); await f.click(pause);
      expect(f.writes.pauseTrigger).toHaveBeenCalledExactlyOnceWith("trigger", 1);
      await f.click(f.button("Cancel"));
      const cancel = f.button("Confirm cancellation");
      await f.click(cancel); await f.click(cancel);
      expect(f.writes.cancelTrigger).toHaveBeenCalledExactlyOnceWith("trigger", 1);
      const id = "00000000-0000-4000-a000-000000000002";
      f.database.createControlAction(id, 1, 1, confirmationAccountContext(config), { kind: "resume_trigger", targetId: "trigger", symbolId: 1 }, Date.now() + 90000);
      await f.click(`ctl:${id}`); await f.click(`ctl:${id}`);
      expect(f.writes.resumeTrigger).toHaveBeenCalledExactlyOnceWith("trigger", 1);
    } finally { f.database.close(); }
  });

  it("invalidates abandoned controls on configuration change, including a switch back", () => {
    const db = new AppDatabase(":memory:");
    try {
      const ctx = confirmationAccountContext(config);
      const action: ControlAction = { kind: "cancel_all", targetId: "fixture", symbolId: 0 };
      db.createControlAction("a", 1, 1, ctx, action, Date.now() + 90000);
      db.invalidateOtherAccountConfirmations("other");
      expect(db.consumeControlAction("a", 1, 1, ctx)).toBeNull();
    } finally { db.close(); }
  });

  it("blocks controls and cancel-all dry run in read-only mode", async () => {
    const f = fixture(new AppDatabase(":memory:"), { ...config, tradingMode: "read_only" });
    try {
      await f.click("oca:preview");
      await f.click("ctl:00000000-0000-4000-a000-000000000003");
      for (const write of Object.values(f.writes)) expect(write).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it("does not retry a cancellation whose outcome is unknown", async () => {
    const f = fixture();
    try {
      await f.click("orders:open");
      await f.click(f.button("Cancel order"));
      const confirm = f.button("Confirm cancellation");
      f.writes.cancelOrder.mockRejectedValueOnce(new Error("fixture timeout"));
      await expect(f.click(confirm)).rejects.toThrow(/could not be confirmed/);
      await f.click(confirm);
      expect(f.writes.cancelOrder).toHaveBeenCalledOnce();
    } finally { f.database.close(); }
  });
});
