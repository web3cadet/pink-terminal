import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { ExchangeGateway, OrderDraft, OrderPreview, OrderReceipt, OrderSummary, TriggerDraft } from "../domain.js";
import type { Logger } from "../log.js";
import type { AppDatabase, IntentRecord } from "../storage/database.js";
import { PolyesterApiError } from "../polyester/transport.js";
import { RiskGuard } from "./risk.js";
import { multiplyDecimals } from "../utils/decimal.js";

export interface PreparedIntent {
  id: string;
  clientId: string;
  expiresAt: number;
  preview?: OrderPreview;
}

export class TradingService {
  private readonly risk: RiskGuard;

  constructor(
    private readonly config: AppConfig,
    private readonly gateway: ExchangeGateway,
    private readonly db: AppDatabase,
    private readonly logger: Logger
  ) {
    this.risk = new RiskGuard(config);
  }

  async prepareOrder(chatId: number, userId: number, draft: OrderDraft): Promise<PreparedIntent> {
    if (this.config.tradingMode === "read_only") throw new Error("Read-only mode blocks order creation");
    const [catalog, overview] = await Promise.all([this.gateway.getCatalog(), this.gateway.listMarketOverview()]);
    const pair = catalog.pairs.find((item) => item.symbolId === draft.symbolId);
    if (!pair) throw new Error("Unknown trading pair");
    this.risk.validateOrder(draft, pair, overview.find((item) => item.symbolId === draft.symbolId));
    const id = randomUUID();
    const clientId = `tg-${randomUUID().replaceAll("-", "")}`;
    const preview = await this.gateway.previewOrder(draft, clientId);
    if (!preview.admissible) throw new Error(`Order rejected by preview: ${preview.rejectionCode ?? "UNKNOWN"} ${preview.rejectionMessage ?? ""}`.trim());
    const expiresAt = Date.now() + this.config.confirmationTtlSeconds * 1_000;
    this.db.createIntent({
      id, chatId, userId, operation: "order", clientId, payload: draft as unknown as Record<string, unknown>,
      preview: preview.raw, status: "previewed", expiresAt
    });
    return { id, clientId, expiresAt, preview };
  }

  async confirmOrder(id: string, chatId: number, userId: number): Promise<OrderReceipt> {
    const intent = this.requireOwnedIntent(id, chatId, userId, "order");
    if (intent.expiresAt < Date.now()) {
      this.db.finishIntent(id, "expired", null, "confirmation expired");
      throw new Error("Confirmation expired. Build and preview the order again.");
    }
    if (!this.db.transitionIntent(id, ["previewed"], "sending")) throw new Error("This confirmation was already used or is no longer valid");
    try {
      const receipt = await this.gateway.createOrder(intent.payload as unknown as OrderDraft, intent.clientId);
      this.db.finishIntent(id, "accepted", receipt.raw, null);
      return receipt;
    } catch (error) {
      if (error instanceof PolyesterApiError && (error.code === "TIMEOUT" || error.status >= 500 || error.status === 0)) {
        this.db.finishIntent(id, "unknown", null, error.message);
        this.logger.warn("order_outcome_unknown", { intentId: id, clientOrderId: intent.clientId });
        throw new Error(`Order outcome is unknown. It will be reconciled by client ID ${intent.clientId}; do not submit it again.`);
      }
      this.db.finishIntent(id, "rejected", null, error instanceof Error ? error.message : "unknown error");
      throw error;
    }
  }

  async prepareTrigger(chatId: number, userId: number, draft: TriggerDraft): Promise<PreparedIntent> {
    if (this.config.tradingMode === "read_only") throw new Error("Read-only mode blocks trigger creation");
    const catalog = await this.gateway.getCatalog();
    const pair = catalog.pairs.find((item) => item.symbolId === draft.symbolId);
    if (!pair) throw new Error("Unknown trading pair");
    this.risk.validateTrigger(draft, pair);
    const id = randomUUID();
    const clientId = `tr-${randomUUID().replaceAll("-", "")}`;
    const expiresAt = Date.now() + this.config.confirmationTtlSeconds * 1_000;
    this.db.createIntent({
      id, chatId, userId, operation: "trigger", clientId, payload: draft as unknown as Record<string, unknown>,
      preview: null, status: "previewed", expiresAt
    });
    return { id, clientId, expiresAt };
  }

  async confirmTrigger(id: string, chatId: number, userId: number): Promise<Record<string, unknown>> {
    const intent = this.requireOwnedIntent(id, chatId, userId, "trigger");
    if (intent.expiresAt < Date.now()) throw new Error("Confirmation expired. Build the trigger again.");
    if (!this.db.transitionIntent(id, ["previewed"], "sending")) throw new Error("This confirmation was already used or is no longer valid");
    try {
      const result = await this.gateway.createTrigger(intent.payload as unknown as TriggerDraft, intent.clientId);
      this.db.finishIntent(id, "accepted", result, null);
      return result;
    } catch (error) {
      this.db.finishIntent(id, "rejected", null, error instanceof Error ? error.message : "unknown error");
      throw error;
    }
  }

  async reconcileUnknownOrders(): Promise<number> {
    let resolved = 0;
    for (const intent of this.db.listUnknownOrderIntents()) {
      try {
        const order = await this.gateway.getOrderByClientId(intent.clientId);
        if (order) {
          this.db.finishIntent(intent.id, "reconciled", order.raw, null);
          resolved += 1;
        }
      } catch (error) {
        this.logger.warn("order_reconcile_failed", { intentId: intent.id, error: error instanceof Error ? error.message : "unknown" });
      }
    }
    return resolved;
  }

  async syncBotTradingVolume(): Promise<number> {
    let addedFills = 0;
    for (const intent of this.db.listOrderIntentsForVolume()) {
      if (this.db.isBotVolumeOrderComplete(intent.clientId)) continue;
      try {
        const order = await this.gateway.getOrderByClientId(intent.clientId);
        if (!order) continue;
        addedFills += await this.syncOrderVolume(intent.userId, intent.clientId, order);
      } catch (error) {
        this.logger.warn("bot_volume_sync_failed", { intentId: intent.id, error: error instanceof Error ? error.message : "unknown" });
      }
    }
    const triggerOwners = new Map(this.db.listTriggerOwnersForVolume().map(item => [item.triggerId, item.userId]));
    if (triggerOwners.size > 0) {
      try {
        const orders = await this.gateway.listOrderHistory();
        for (const order of orders) {
          const origin = order.raw.origin;
          if (!origin || typeof origin !== "object" || Array.isArray(origin)) continue;
          const triggerIdValue = (origin as Record<string, unknown>).triggerId;
          const triggerId = typeof triggerIdValue === "string" || typeof triggerIdValue === "number" ? String(triggerIdValue) : "";
          const userId = triggerOwners.get(triggerId);
          if (userId === undefined) continue;
          const trackingId = `trigger:${triggerId}:order:${order.orderId}`;
          if (this.db.isBotVolumeOrderComplete(trackingId)) continue;
          addedFills += await this.syncOrderVolume(userId, trackingId, order);
        }
      } catch (error) {
        this.logger.warn("strategy_volume_sync_failed", { error: error instanceof Error ? error.message : "unknown" });
      }
    }
    return addedFills;
  }

  private async syncOrderVolume(userId: number, trackingId: string, order: OrderSummary): Promise<number> {
    const details = await this.gateway.getOrderDetails(order.orderId);
    if (!details) return 0;
    let addedFills = 0;
    details.executions.forEach((execution, index) => {
      const executionKey = execution.matchId ?? [order.orderId, execution.tsNs ?? "", execution.price, execution.qty, index].join(":");
      const quoteVolume = multiplyDecimals(execution.qty, execution.price, 18);
      if (this.db.recordBotFillVolume(userId, trackingId, executionKey, quoteVolume)) addedFills += 1;
    });
    if (isTerminalOrderStatus(details.order.status) && !details.nextPageToken) {
      this.db.markBotVolumeOrderComplete(trackingId, userId, details.order.status);
    }
    return addedFills;
  }

  private requireOwnedIntent(id: string, chatId: number, userId: number, operation: "order" | "trigger"): IntentRecord {
    const intent = this.db.getIntent(id);
    if (!intent || intent.chatId !== chatId || intent.userId !== userId || intent.operation !== operation) throw new Error("Confirmation not found");
    return intent;
  }
}

function isTerminalOrderStatus(status: string): boolean {
  const normalized = status.toUpperCase();
  return ["FILLED", "CANCEL", "REJECT", "EXPIRED"].some(value => normalized.includes(value));
}
