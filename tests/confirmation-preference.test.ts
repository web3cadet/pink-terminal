import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppDatabase } from "../src/storage/database.js";

it("persists the opt-out across database reopen without affecting a different configuration", () => {
  const root = mkdtempSync(path.join(tmpdir(), "Pink confirmation preference "));
  let db: AppDatabase | undefined;
  try {
    const file = path.join(root, "state.sqlite");
    db = new AppDatabase(file);
    expect(db.orderConfirmationEnabled(1, 1, "account-a")).toBe(true);
    db.setOrderConfirmation(1, 1, "account-a", false); db.close(); db = undefined;
    db = new AppDatabase(file);
    expect(db.orderConfirmationEnabled(1, 1, "account-a")).toBe(false);
    expect(db.orderConfirmationEnabled(1, 1, "account-b")).toBe(true);
    db.setOrderConfirmation(1, 1, "account-a", true);
    expect(db.orderConfirmationEnabled(1, 1, "account-a")).toBe(true);
    expect(db.orderAmountMode(1, 1, "account-a")).toBe("quote");
    db.setOrderAmountMode(1, 1, "account-a", "base"); db.close(); db = new AppDatabase(file);
    expect(db.orderAmountMode(1, 1, "account-a")).toBe("base");
    expect(db.orderAmountMode(1, 2, "account-a")).toBe("quote");
    expect(db.orderAmountMode(2, 1, "account-a")).toBe("quote");
    expect(db.orderAmountMode(1, 1, "account-b")).toBe("quote");
  } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
});
