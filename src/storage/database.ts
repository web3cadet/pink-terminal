import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decimalToScaled, scaledToDecimal } from "../utils/decimal.js";

export interface WizardState {
  flow: "order" | "trigger" | "cancel_all";
  step: string;
  data: Record<string, unknown>;
}

export interface IntentRecord {
  id: string;
  chatId: number;
  userId: number;
  operation: "order" | "trigger";
  clientId: string;
  accountContext?: string | null;
  payload: Record<string, unknown>;
  preview: Record<string, unknown> | null;
  status: string;
  expiresAt: number;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ControlAction {
  kind: "cancel_order_prompt" | "cancel_order" | "cancel_trigger_prompt" | "cancel_trigger" | "pause_trigger" | "resume_trigger" | "cancel_all";
  targetId: string;
  symbolId: number;
}

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    const absolute = path === ":memory:" ? path : resolve(path);
    if (path !== ":memory:") mkdirSync(dirname(absolute), { recursive: true });
    this.db = new DatabaseSync(absolute);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void { this.db.close(); }

  createControlAction(id: string, chatId: number, userId: number, context: string, action: ControlAction, expiresAt: number): void {
    this.db.prepare("DELETE FROM control_actions WHERE expires_at <= ?").run(Date.now());
    this.db.prepare("INSERT INTO control_actions (id, chat_id, user_id, account_context, payload_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, chatId, userId, context, JSON.stringify(action), expiresAt);
  }

  consumeControlAction(id: string, chatId: number, userId: number, context: string): ControlAction | null {
    // Atomic consumption before any await or exchange request prevents double submission.
    const row = this.db.prepare("DELETE FROM control_actions WHERE id = ? AND chat_id = ? AND user_id = ? AND account_context = ? AND expires_at > ? RETURNING payload_json")
      .get(id, chatId, userId, context, Date.now()) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as ControlAction : null;
  }

  invalidateControlActions(chatId: number, userId: number): void {
    this.db.prepare("DELETE FROM control_actions WHERE chat_id = ? AND user_id = ?").run(chatId, userId);
  }

  saveWizard(chatId: number, userId: number, state: WizardState): void {
    this.db.prepare(`
      INSERT INTO wizard_sessions (chat_id, user_id, flow, step, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        flow = excluded.flow, step = excluded.step, data_json = excluded.data_json, updated_at = excluded.updated_at
    `).run(chatId, userId, state.flow, state.step, JSON.stringify(state.data), Date.now());
  }

  getWizard(chatId: number, userId: number): WizardState | null {
    const row = this.db.prepare("SELECT flow, step, data_json FROM wizard_sessions WHERE chat_id = ? AND user_id = ?")
      .get(chatId, userId) as { flow: "order" | "trigger" | "cancel_all"; step: string; data_json: string } | undefined;
    return row ? { flow: row.flow, step: row.step, data: JSON.parse(row.data_json) as Record<string, unknown> } : null;
  }

  clearWizard(chatId: number, userId: number): void {
    this.db.prepare("DELETE FROM wizard_sessions WHERE chat_id = ? AND user_id = ?").run(chatId, userId);
  }

  createIntent(input: Omit<IntentRecord, "createdAt" | "updatedAt" | "result" | "error">): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO operation_intents
        (id, chat_id, user_id, operation, client_id, payload_json, preview_json, status, expires_at, created_at, updated_at, account_context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.chatId, input.userId, input.operation, input.clientId, JSON.stringify(input.payload),
      input.preview ? JSON.stringify(input.preview) : null, input.status, input.expiresAt, now, now, input.accountContext ?? null
    );
  }

  getIntent(id: string): IntentRecord | null {
    const row = this.db.prepare("SELECT * FROM operation_intents WHERE id = ?").get(id) as DbIntentRow | undefined;
    return row ? mapIntent(row) : null;
  }

  invalidateOtherAccountConfirmations(context: string): void {
    this.db.prepare("DELETE FROM control_actions WHERE account_context != ?").run(context);
    this.db.prepare("UPDATE operation_intents SET status = 'superseded', updated_at = ? WHERE status = 'previewed' AND (account_context IS NULL OR account_context != ?)")
      .run(Date.now(), context);
  }

  invalidateConfirmations(chatId: number, userId: number, operation?: "order" | "trigger"): void {
    this.db.prepare("UPDATE operation_intents SET status = 'superseded', updated_at = ? WHERE chat_id = ? AND user_id = ? AND status = 'previewed' AND (? IS NULL OR operation = ?)")
      .run(Date.now(), chatId, userId, operation ?? null, operation ?? null);
  }

  listUnknownTriggerIntents(): IntentRecord[] {
    return (this.db.prepare("SELECT * FROM operation_intents WHERE operation = 'trigger' AND status IN ('sending', 'unknown') ORDER BY created_at").all() as unknown as DbIntentRow[]).map(mapIntent);
  }

  transitionIntent(id: string, fromStatuses: string[], toStatus: string): boolean {
    if (fromStatuses.length === 0) return false;
    const placeholders = fromStatuses.map(() => "?").join(",");
    const result = this.db.prepare(`UPDATE operation_intents SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(toStatus, Date.now(), id, ...fromStatuses);
    return Number(result.changes) === 1;
  }

  finishIntent(id: string, status: string, result: Record<string, unknown> | null, error: string | null): void {
    this.db.prepare("UPDATE operation_intents SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, result ? JSON.stringify(result) : null, error, Date.now(), id);
  }

  listUnknownOrderIntents(): IntentRecord[] {
    const rows = this.db.prepare("SELECT * FROM operation_intents WHERE operation = 'order' AND status IN ('sending', 'unknown') ORDER BY created_at")
      .all() as unknown as DbIntentRow[];
    return rows.map(mapIntent);
  }

  listOrderIntentsForVolume(): IntentRecord[] {
    const rows = this.db.prepare("SELECT * FROM operation_intents WHERE operation = 'order' AND status IN ('accepted', 'reconciled', 'unknown') ORDER BY created_at")
      .all() as unknown as DbIntentRow[];
    return rows.map(mapIntent);
  }

  listTriggerOwnersForVolume(): Array<{ userId: number; triggerId: string }> {
    const rows = this.db.prepare(`
      SELECT user_id, result_json FROM operation_intents
      WHERE operation = 'trigger' AND status IN ('accepted', 'reconciled') AND result_json IS NOT NULL
    `).all() as unknown as Array<{ user_id: number; result_json: string }>;
    return rows.flatMap(row => {
      const result = JSON.parse(row.result_json) as Record<string, unknown>;
      const triggerId = result.triggerId;
      return typeof triggerId === "string" || typeof triggerId === "number"
        ? [{ userId: row.user_id, triggerId: String(triggerId) }]
        : [];
    });
  }

  listBotOrderClientIds(userId: number): string[] {
    const rows = this.db.prepare(`
      SELECT client_id FROM operation_intents
      WHERE operation = 'order' AND user_id = ? AND status IN ('accepted', 'reconciled', 'unknown')
    `).all(userId) as unknown as Array<{ client_id: string }>;
    return rows.map(row => row.client_id);
  }

  listBotTriggerDrafts(userId: number): Array<{ triggerId: string; payload: Record<string, unknown> }> {
    const rows = this.db.prepare(`
      SELECT payload_json, result_json FROM operation_intents
      WHERE operation = 'trigger' AND user_id = ? AND status IN ('accepted', 'reconciled') AND result_json IS NOT NULL
    `).all(userId) as unknown as Array<{ payload_json: string; result_json: string }>;
    return rows.flatMap(row => {
      const result = JSON.parse(row.result_json) as Record<string, unknown>;
      const triggerId = result.triggerId;
      return typeof triggerId === "string" || typeof triggerId === "number"
        ? [{ triggerId: String(triggerId), payload: JSON.parse(row.payload_json) as Record<string, unknown> }]
        : [];
    });
  }

  recordBotFillVolume(userId: number, clientOrderId: string, executionKey: string, quoteVolume: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO bot_fill_volume
        (user_id, client_order_id, execution_key, quote_volume_e18, recorded_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, clientOrderId, executionKey, decimalToScaled(quoteVolume, 18), Date.now());
    return Number(result.changes) === 1;
  }

  getBotTradingVolume(userId: number): string {
    const rows = this.db.prepare("SELECT quote_volume_e18 FROM bot_fill_volume WHERE user_id = ?")
      .all(userId) as unknown as Array<{ quote_volume_e18: string }>;
    const total = rows.reduce((sum, row) => sum + BigInt(row.quote_volume_e18), 0n);
    return scaledToDecimal(total, 18);
  }

  getBotTradingVolumeByTrackingPrefix(userId: number, prefix: string): string {
    const rows = this.db.prepare("SELECT quote_volume_e18 FROM bot_fill_volume WHERE user_id = ? AND client_order_id LIKE ?")
      .all(userId, `${prefix}%`) as unknown as Array<{ quote_volume_e18: string }>;
    const total = rows.reduce((sum, row) => sum + BigInt(row.quote_volume_e18), 0n);
    return scaledToDecimal(total, 18);
  }

  isBotVolumeOrderComplete(clientOrderId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM bot_volume_orders WHERE client_order_id = ? AND complete = 1")
      .get(clientOrderId));
  }

  markBotVolumeOrderComplete(clientOrderId: string, userId: number, status: string): void {
    this.db.prepare(`
      INSERT INTO bot_volume_orders (client_order_id, user_id, status, complete, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(client_order_id) DO UPDATE SET
        status = excluded.status, complete = 1, updated_at = excluded.updated_at
    `).run(clientOrderId, userId, status, Date.now());
  }

  rememberStatus(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  readStatus(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS control_actions (
        id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        account_context TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wizard_sessions (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        flow TEXT NOT NULL,
        step TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS operation_intents (
        id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('order', 'trigger')),
        client_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        preview_json TEXT,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operation_intents_status_idx ON operation_intents(status, updated_at);

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bot_fill_volume (
        user_id INTEGER NOT NULL,
        client_order_id TEXT NOT NULL,
        execution_key TEXT NOT NULL,
        quote_volume_e18 TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (client_order_id, execution_key)
      );
      CREATE INDEX IF NOT EXISTS bot_fill_volume_user_idx ON bot_fill_volume(user_id, recorded_at);

      CREATE TABLE IF NOT EXISTS bot_volume_orders (
        client_order_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        complete INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(operation_intents)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "account_context")) {
      this.db.exec("ALTER TABLE operation_intents ADD COLUMN account_context TEXT");
    }
  }
}

interface DbIntentRow {
  id: string; chat_id: number; user_id: number; operation: "order" | "trigger"; client_id: string;
  payload_json: string; preview_json: string | null; status: string; expires_at: number;
  result_json: string | null; error: string | null; created_at: number; updated_at: number;
  account_context: string | null;
}

function mapIntent(row: DbIntentRow): IntentRecord {
  return {
    id: row.id, chatId: row.chat_id, userId: row.user_id, operation: row.operation, clientId: row.client_id,
    accountContext: row.account_context,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    preview: row.preview_json ? JSON.parse(row.preview_json) as Record<string, unknown> : null,
    status: row.status, expiresAt: row.expires_at,
    result: row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : null,
    error: row.error, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
