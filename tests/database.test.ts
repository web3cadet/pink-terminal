import { describe, expect, it } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("durable intent journal", () => {
  it("migrates existing history without dropping fills or submitted orders", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pink-db-migration-"));
    const file = path.join(root, "history.sqlite");
    try {
      const initial = new AppDatabase(file);
      initial.createIntent({ id: "accepted", chatId: 1, userId: 1, operation: "order", clientId: "old-client", payload: { symbolId: 1 }, preview: {}, status: "accepted", expiresAt: 1 });
      initial.recordBotFillVolume(1, "old-client", "fill", "12.5");
      initial.close();
      const legacy = new DatabaseSync(file);
      legacy.exec("ALTER TABLE operation_intents DROP COLUMN account_context");
      legacy.close();
      for (let reopen = 0; reopen < 2; reopen++) {
        const upgraded = new AppDatabase(file);
        try {
          expect(upgraded.getIntent("accepted")?.accountContext).toBeNull();
          expect(upgraded.getIntent("accepted")?.status).toBe("accepted");
          expect(upgraded.getBotTradingVolume(1)).toBe("12.5");
        } finally { upgraded.close(); }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("permits only one confirmation transition", () => {
    const db = new AppDatabase(":memory:");
    db.createIntent({
      id: "intent-1", chatId: 1, userId: 2, operation: "order", clientId: "client-1",
      payload: { symbolId: 1 }, preview: { admissible: true }, status: "previewed", expiresAt: Date.now() + 1000
    });
    expect(db.transitionIntent("intent-1", ["previewed"], "sending")).toBe(true);
    expect(db.transitionIntent("intent-1", ["previewed"], "sending")).toBe(false);
    expect(db.getIntent("intent-1")?.status).toBe("sending");
    db.close();
  });

  it("stores each bot fill once and sums exact quote volume", () => {
    const db = new AppDatabase(":memory:");
    expect(db.recordBotFillVolume(2, "tg-1", "fill-1", "10.25")).toBe(true);
    expect(db.recordBotFillVolume(2, "tg-1", "fill-1", "10.25")).toBe(false);
    expect(db.recordBotFillVolume(2, "tg-1", "fill-2", "2.09")).toBe(true);
    expect(db.getBotTradingVolume(2)).toBe("12.34");
    expect(db.getBotTradingVolume(3)).toBe("0");
    db.close();
  });
});
