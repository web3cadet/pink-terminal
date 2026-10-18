import { randomUUID } from "node:crypto";
import { Bot, GrammyError, HttpError, InlineKeyboard, type Context } from "grammy";
import type { AppConfig } from "../config.js";
import type { ExchangeGateway, OrderDraft, OrderSide, PairConfig, TriggerDraft } from "../domain.js";
import type { Logger } from "../log.js";
import type { AppDatabase, WizardState, ControlAction } from "../storage/database.js";
import type { TradingService } from "../services/trading.js";
import { confirmationAccountContext } from "../services/trading.js";
import { decimalToScaled, scaledToDecimal } from "../utils/decimal.js";
import { escapeHtml, shorten } from "../utils/html.js";
import { formatOrderDraft, formatTriggerDraft, mainKeyboard, orderKindCard, orderKindKeyboard, orderOptionsKeyboard, pairsKeyboard, sparkline, strategyKindLabel } from "./ui.js";
import { amountPrompt, orderBookTable, orderSettingsCard, strategyPrompt } from "./card-copy.js";
import { renderOverview } from "./overview.js";
import { orderBalances, orderMinimums, orderFeeLine } from "./order-context.js";
import { applyOrderAmountInput, resolveQuoteAmount } from "./order-sizing.js";
import { assetLink, heading, modeText, numberText, pairLink, pairUrl, positiveInput, terminalHeading, WEBSITE } from "./presentation.js";

const PAGE_SIZE = 8;
const MARKET_REFRESH_MS = 1_000;
const DECIMAL = /^(0|[1-9]\d*)(?:\.\d+)?$/;

export function createTelegramBot(deps: {
  config: AppConfig;
  gateway: ExchangeGateway;
  database: AppDatabase;
  trading: TradingService;
  logger: Logger;
}): Bot {
  const { config, gateway, database, trading, logger } = deps;
  const bot = new Bot(config.telegramToken);
  const accountContext = confirmationAccountContext(config);
  // Reuse only a just-displayed balance while navigating the same pair. Order
  // sizing, percentages, preview and submission always fetch their own data.
  const navigationBalances = new Map<number, { symbolId: number; text: string; expiresAt: number }>();
  const balancesForNavigation = async (ctx: Context, pair: PairConfig, fresh = false): Promise<string> => {
    const { chatId } = requireIds(ctx);
    const cached = navigationBalances.get(chatId);
    if (!fresh && cached?.symbolId === pair.symbolId && cached.expiresAt > Date.now()) return cached.text;
    const fallback = `\n<b>Available to trade</b>\n${escapeHtml(pair.baseAsset)}: unavailable\n${escapeHtml(pair.quoteAsset)}: unavailable\n`;
    const started = Date.now();
    const text = await displayData(orderBalances(gateway, pair), fallback, 1_000);
    if (!text.includes(": unavailable")) navigationBalances.set(chatId, { symbolId: pair.symbolId, text, expiresAt: started + 5_000 });
    else navigationBalances.delete(chatId);
    return text;
  };
  const confirmationEnabled = (ctx: Context) => {
    const ids = requireIds(ctx);
    return database.orderConfirmationEnabled(ids.chatId, ids.userId, accountContext);
  };
  const controlButton = (ctx: Context, action: ControlAction): string => {
    const ids = requireIds(ctx);
    const id = randomUUID();
    database.createControlAction(id, ids.chatId, ids.userId, confirmationAccountContext(config), action, Date.now() + config.confirmationTtlSeconds * 1000);
    return `ctl:${id}`;
  };
  bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === "sendMessage" || method === "editMessageText") Object.assign(payload, { link_preview_options: { is_disabled: true } });
    return previous(method, payload, signal);
  });
  const renderOrderPanel = async (ctx: Context, state: WizardState, text: string, keyboard: InlineKeyboard, newMessage = false) => {
    const messageId = ctx.callbackQuery?.message?.message_id ?? Number(state.data.inputPromptId);
    // Buttons navigate within their card; text input gets a reply below the user's message.
    if (!newMessage && ctx.callbackQuery && Number.isSafeInteger(messageId) && messageId > 0) {
      try {
        await bot.api.editMessageText(requireIds(ctx).chatId, messageId, text, { parse_mode: "HTML", reply_markup: keyboard });
        state.data.inputPromptId = messageId;
        return;
      } catch (error) {
        if (error instanceof GrammyError && error.description.includes("message is not modified")) {
          state.data.inputPromptId = messageId;
          return;
        }
        // A deleted/too-old panel can be replaced; a network failure is not proof it was deleted.
        if (!(error instanceof GrammyError) || !/message to edit not found|message can't be edited/i.test(error.description)) throw error;
      }
    }
    const response = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    state.data.inputPromptId = response.message_id;
    if (Number.isSafeInteger(messageId) && messageId > 0 && messageId !== response.message_id) {
      await bot.api.editMessageReplyMarkup(requireIds(ctx).chatId, messageId, { reply_markup: { inline_keyboard: [] } })
        .catch(() => undefined); // Old/deleted cards must not prevent delivery of the new reply.
    }
  };
  const requestInput = async (ctx: Context, state: WizardState) => {
    const pair = requirePair((await gateway.getCatalog()).pairs, Number(state.data.symbolId));
    const quote = state.data.sizingMode === "quote";
    const sell = state.data.side === "SELL";
    const base = escapeHtml(pair.baseAsset), currency = escapeHtml(pair.quoteAsset);
    let prompt = [
      terminalHeading(`New order · ${state.step === "price" ? "price" : state.step === "expiry" ? "expiry" : "amount"}`),
      `${pairLink(pair.symbol)} · ${sell ? "🔴 Sell" : "🟢 Buy"}`,
      await orderBalances(gateway, pair),
      state.data.inputError ? `⚠️ ${escapeHtml(String(state.data.inputError))}\n` : "",
      state.step === "expiry" ? "Enter 1–43,200 minutes from now, or an ISO 8601 timestamp with timezone.\nExample: 60 = expires in 1 hour."
        : state.step === "price" ? `<b>Enter the limit price in ${currency} per ${base}.</b>\nPrice step: ${escapeHtml(pair.tickSize)}.`
        : [
          amountPrompt(pair, state.data as unknown as OrderDraft, quote),
          "", orderMinimums(pair)
        ].join("\n")
    ].join("\n");
    const keyboard = new InlineKeyboard();
    if (state.step === "size") keyboard.text(quote ? `Enter in ${pair.baseAsset} instead` : `Enter in ${pair.quoteAsset} instead`, quote ? "ordsize:base" : "ordsize:quote").row();
    keyboard.text("⚙ Order settings", "ordoptions").row().text("✕ Discard order", "cancel-flow");
    if (!confirmationEnabled(ctx)) prompt += "\n\n⚠ <b>Confirmation OFF:</b> the order is submitted after the last required input.";
    await renderOrderPanel(ctx, state, prompt, keyboard);
    saveFlow(ctx, database, state);
  };
  const liveSessions = new Map<number, { messageId: number; timer?: NodeJS.Timeout; lastText: string; busy: boolean; page: number; retryUntil: number; pending?: Promise<void> }>();
  const submitOrder = async (ctx: Context, id: string, state: WizardState): Promise<void> => {
    const ids = requireIds(ctx);
    // Keep submission errors outside the preview error handler: a timeout may mean an order WAS sent.
    let result: string;
    try {
      const receipt = await trading.confirmOrder(id, ids.chatId, ids.userId);
      logger.info("order_submitted", { mode: config.tradingMode, status: receipt.status });
      result = [
        receipt.status === "paper" ? "<b>🧪 Paper order accepted</b>" : "<b>✅ Order accepted</b>",
        formatOrderDraft(state.data as unknown as OrderDraft),
        `Order ID: <code>${escapeHtml(receipt.orderId ?? "pending")}</code>`,
        receipt.status === "paper" ? "Simulated order. Check Orders for fills." : "Accepted by Polyester. Check Orders for fills."
      ].join("\n");
    } catch (error) {
      logger.warn("order_submission_needs_review", { error: error instanceof Error ? error.message : "unknown" });
      result = `${terminalHeading("Submission status unknown")}\n\n${escapeHtml(error instanceof Error ? error.message : "Submission could not be confirmed.")}\n\nThe order may have been accepted. Check Orders before trying again. No automatic retry.`;
    }
    await renderOrderPanel(ctx, state, result, new InlineKeyboard().text("📋 Open orders", "orders:open").row().text("‹ Terminal", "home"), true);
  };
  const prepareAndShowOrderConfirmation = async (ctx: Context, state: WizardState): Promise<void> => {
    const ids = requireIds(ctx);
    const draft = state.data as unknown as OrderDraft;
    if (!draft.qty && !draft.maxQuoteDebit && !draft.quoteAmount) { state.step = "size"; await requestInput(ctx, state); return; }
    if (draft.kind !== "MARKET_IOC" && !draft.price) { state.step = "price"; await requestInput(ctx, state); return; }
    if (draft.kind === "LIMIT_GTD" && !draft.expireAt) { state.step = "expiry"; await requestInput(ctx, state); return; }
    let immediateId: string | undefined;
    try {
      const catalog = await gateway.getCatalog();
      const pair = requirePair(catalog.pairs, draft.symbolId);
      await resolveQuoteAmount(gateway, pair, draft);
      if (config.tradingMode === "read_only") {
        await renderOrderPanel(ctx, state, `${terminalHeading("Order preview")}\n\n${formatOrderDraft(draft)}\n\n<i>Read-only mode: submission is disabled.</i>`, new InlineKeyboard().text("✕ Discard order", "home"));
        saveFlow(ctx, database, state);
        return;
      }
      const prepared = await trading.prepareOrder(ids.chatId, ids.userId, draft);
      delete state.data.inputError;
      if (!confirmationEnabled(ctx)) {
        database.clearWizard(ids.chatId, ids.userId);
        immediateId = prepared.id;
      } else {
      const spend = draft.quoteAmount ? `~${draft.quoteAmount} ${pair.quoteAsset}` : draft.maxQuoteDebit ? `${draft.maxQuoteDebit} ${pair.quoteAsset}` : `${draft.qty ?? "—"} ${pair.baseAsset}`;
      const side = draft.side === "BUY" ? "BUY" : "SELL";
      const confirmationText = [
        terminalHeading("Confirm order"),
        pairLink(pair.symbol),
        await orderBalances(gateway, pair),
        "",
        formatOrderDraft(draft),
        await orderFeeLine(gateway, draft.symbolId),
        "",
        "Nothing submitted yet.",
        config.tradingMode === "paper" ? "🧪 Confirm to create a simulated order." : "Confirm to submit this testnet order.",
        `Confirmation expires at <code>${new Date(prepared.expiresAt).toISOString()}</code>.`,
        "<i>Disabling future confirmations does not submit this order.</i>"
      ].join("\n");
      const keyboard = new InlineKeyboard()
        .text(shorten(`✅ Confirm ${side} · ${spend}`, 58), `confirm:o:${prepared.id}`).row()
        .text("✕ Discard order", "home").row()
        .text("Disable future confirmations", `ordskip:${prepared.id}`);

      await renderOrderPanel(ctx, state, confirmationText, keyboard);
      database.clearWizard(ids.chatId, ids.userId);
      }
    } catch (error) {
      state.step = "options";
      state.data.inputError = error instanceof Error ? error.message : "Order preview failed";
      saveFlow(ctx, database, state);
      const pair = await gateway.getCatalog().then(catalog => catalog.pairs.find(item => item.symbolId === draft.symbolId)).catch(() => undefined);
      const keyboard = new InlineKeyboard().text("✎ Change amount", "order:edit:size").row();
      if (draft.quoteAmount && pair) keyboard.text(`Enter in ${pair.baseAsset} instead`, "ordsize:base").row();
      keyboard.text("✕ Discard order", "cancel-flow");
      await renderOrderPanel(ctx, state, [
        terminalHeading("Order not submitted"),
        pair ? pairLink(pair.symbol) : "",
        pair ? await orderBalances(gateway, pair) : "Balances unavailable",
        "",
        ...(pair && draft.quoteAmount && draft.sizingPrice ? [
          `Entered: <b>${escapeHtml(draft.quoteAmount)} ${escapeHtml(pair.quoteAsset)}</b> ${draft.balancePercent && draft.side === "BUY" ? "including Fee" : "before Fee"}`,
          `Reference price: <b>${escapeHtml(draft.sizingPrice)} ${escapeHtml(pair.quoteAsset)}</b> per ${escapeHtml(pair.baseAsset)}`,
          `Calculated quantity: <b>${escapeHtml(draft.qty ?? "—")} ${escapeHtml(pair.baseAsset)}</b>`,
          ""
        ] : []),
        `⚠️ ${escapeHtml(String(state.data.inputError))}`,
        "",
        "No order was sent. Review the details before trying again."
      ].join("\n"), keyboard);
      saveFlow(ctx, database, state);
      return;
    }
    if (immediateId) await submitOrder(ctx, immediateId, state);
  };

  const prepareAndShowTriggerConfirmation = async (ctx: Context, state: WizardState): Promise<void> => {
    const ids = requireIds(ctx);
    const draft = state.data as unknown as TriggerDraft;
    try {
      const prepared = await trading.prepareTrigger(ids.chatId, ids.userId, draft);
      database.clearWizard(ids.chatId, ids.userId);
      await editOrReply(ctx, [
        terminalHeading("Confirm strategy"),
        "",
        formatTriggerDraft(draft),
        "",
        "Nothing submitted yet.",
        config.tradingMode === "paper" ? "🧪 Confirm to simulate activation." : "Confirm to start automatic execution.",
        `Confirmation expires at <code>${new Date(prepared.expiresAt).toISOString()}</code>.`
      ].join("\n"), new InlineKeyboard()
        .text("✅ Confirm & activate", `confirm:t:${prepared.id}`).row()
        .text("✕ Discard strategy", "home"));
    } catch (error) {
      state.step = "ready";
      state.data.inputError = error instanceof Error ? error.message : "Strategy validation failed";
      saveFlow(ctx, database, state);
      await editOrReply(ctx, [
        terminalHeading("Strategy needs attention"),
        "",
        formatTriggerDraft(draft),
        "",
        `⚠️ ${escapeHtml(String(state.data.inputError))}`,
        "No strategy was created."
      ].join("\n"), new InlineKeyboard().text("✎ Edit strategy", "tredit").row().text("↻ Check again", "trpreview").row().text("✕ Discard strategy", "cancel-flow"));
    }
  };

  const stopLiveForChat = async (chatId: number): Promise<void> => {
    const session = liveSessions.get(chatId);
    if (!session) return;
    clearInterval(session.timer);
    liveSessions.delete(chatId);
    // Drain an edit already sent to Telegram before navigating to another panel.
    await session.pending?.catch(() => undefined);
  };

  const refreshLiveSession = async (chatId: number): Promise<void> => {
    const session = liveSessions.get(chatId);
    if (!session || session.busy || Date.now() < session.retryUntil) return;
    session.busy = true;
    try {
      const snapshot = await renderTerminalSnapshot(gateway, config, true, session.page);
      if (liveSessions.get(chatId) !== session) return;
      const content = (text: string) => text.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/g, "");
      if (content(snapshot.text) !== content(session.lastText)) {
        session.pending = bot.api.editMessageText(chatId, session.messageId, snapshot.text, { parse_mode: "HTML", reply_markup: snapshot.keyboard }).then(() => undefined);
        await session.pending;
        session.lastText = snapshot.text;
      }
    } catch (error) {
      const notModified = error instanceof GrammyError && error.description.includes("message is not modified");
      const retryAfter = error instanceof GrammyError && error.error_code === 429
        ? Math.max(1, Number(error.parameters.retry_after ?? 1))
        : 0;
      if (retryAfter > 0) {
        const current = liveSessions.get(chatId);
        if (current === session) current.retryUntil = Date.now() + retryAfter * 1_000;
      }
      if (!notModified) {
        logger.warn("live_terminal_update_failed", { chatId, error: error instanceof Error ? error.message : "unknown" });
      }
    } finally {
      const current = liveSessions.get(chatId);
      if (current === session) current.busy = false;
    }
  };

  const startLiveForChat = async (chatId: number, messageId: number, page: number): Promise<void> => {
    await stopLiveForChat(chatId);
    const snapshot = await renderTerminalSnapshot(gateway, config, true, page);
    await bot.api.editMessageText(chatId, messageId, snapshot.text, { parse_mode: "HTML", reply_markup: snapshot.keyboard });
    const timer = setInterval(() => void refreshLiveSession(chatId), MARKET_REFRESH_MS);
    timer.unref();
    liveSessions.set(chatId, { messageId, timer, lastText: snapshot.text, busy: false, page, retryUntil: 0 });
  };

  const chatUpdates = new Map<number, Promise<void>>();
  const pendingNavigation = new Set<string>();
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !userId) return;
    const chatAllowed = config.allowedChatIds.has(chatId);
    const userAllowed = config.allowedUserIds.size === 0 || config.allowedUserIds.has(userId);
    if (!chatAllowed || !userAllowed) {
      logger.warn("telegram_access_denied", { chatId, userId });
      if (ctx.message?.text === "/start") await ctx.reply("Access denied.");
      return;
    }
    const callbackData = ctx.callbackQuery?.data;
    const navigation = callbackData && /^(?:pair:\d+|pairtf:\d+:(?:1m|5m|1h|4h)|book:\d+:(?:5|10|20)|markets:\d+|ordpair:\d+|orderpairside:\d+:(?:BUY|SELL)|ordside:(?:BUY|SELL))$/.test(callbackData);
    const navigationKey = navigation ? `${chatId}:${userId}:${ctx.callbackQuery?.message?.message_id}:${callbackData}` : undefined;
    if (navigationKey) {
      const duplicate = pendingNavigation.has(navigationKey);
      pendingNavigation.add(navigationKey);
      // The spinner acknowledgement is not the action. Its network delay or
      // expiry must not block navigation or reorder updates before queuing.
      void ctx.answerCallbackQuery().catch(() => undefined);
      if (duplicate) return;
    }
    // Serialize updates from this chat so repeated amount messages cannot create two immediate orders.
    const previous = chatUpdates.get(chatId);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    chatUpdates.set(chatId, current);
    await previous;
    try {
      if (!navigation) navigationBalances.delete(chatId);
      if (ctx.message?.text?.startsWith("/") || callbackData === "home" || callbackData === "markets:0") clearFlow(ctx, database);
      if ((callbackData && !callbackData.startsWith("live:")) || ctx.message) await stopLiveForChat(chatId);
      await next();
    } finally {
      release();
      if (navigationKey) pendingNavigation.delete(navigationKey);
      if (chatUpdates.get(chatId) === current) chatUpdates.delete(chatId);
    }
  });

  bot.command("start", async (ctx) => showHome(ctx, config, gateway, database));
  bot.command("menu", async (ctx) => showHome(ctx, config, gateway, database));
  bot.hears(/^(?:☰ Menu|💗 Pink Terminal)$/, async (ctx) => {
    clearFlow(ctx, database);
    await showHome(ctx, config, gateway, database);
  });
  bot.command("cancel", async (ctx) => {
    clearFlow(ctx, database);
    await ctx.reply("Current action canceled.", { reply_markup: mainKeyboard(config.tradingMode === "read_only") });
  });

  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());
  bot.callbackQuery("home", async (ctx) => { await ctx.answerCallbackQuery(); await showHome(ctx, config, gateway, database, true); });
  bot.callbackQuery("help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, [
      terminalHeading("Help"),
      "",
      "<b>Trading</b> — place market and limit orders.",
      "<b>Orders</b> — view execution and cancel open orders.",
      "<b>Strategies</b> — configure automated execution.",
      "<b>Configuration</b> — set amount units and order confirmation.",
      "",
      "API secrets stay on your host. Never send them through Telegram.",
      "",
      `/cancel — exit the current setup.\n<a href="${WEBSITE}">Open Polyester testnet ↗</a>`
    ].join("\n"), mainKeyboard(config.tradingMode === "read_only"));
  });

  bot.callbackQuery("safety", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, [
      terminalHeading("Security"), "",
      `Mode: <b>${config.tradingMode === "live" ? "Testnet trading" : config.tradingMode === "paper" ? "Local simulation" : "Read-only"}</b>`,
      `API credentials: <b>${config.apiKeyId && config.apiSecretHex ? "Configured" : "Not configured"}</b>`,
      "Withdrawals: Not available in this bot",
      "",
      "Actual API permissions are controlled in Polyester.\nNever send API secrets through Telegram."
    ].join("\n"), new InlineKeyboard().text("‹ Terminal", "home"));
  });

  const showConfiguration = async (ctx: Context) => {
    const ids = requireIds(ctx);
    const mode = database.orderAmountMode(ids.chatId, ids.userId, accountContext);
    await editOrReply(ctx, [terminalHeading("Configuration"), "",
      `Order confirmation: <b>${confirmationEnabled(ctx) ? "ON" : "OFF · immediate submission"}</b>`,
      `Amount input: <b>${mode === "base" ? "Token quantity" : "Quote value"}</b>`, "",
      "<b>INPUT MODES</b>",
      "Quote value — amount in the pair's quote asset (USDT, USDC or another asset).",
      "Token quantity — amount in the base asset.", "",
      "<b>PERCENTAGES · BOTH MODES</b>",
      "Buy — share of available payment asset, including fees.",
      "Sell — share of available asset being sold.", "",
      "Exact amounts exclude fees.\nPercentage amounts are calculated when entered; market prices may change."
    ].join("\n"), new InlineKeyboard().text("Order confirmation", "configuration:confirmation").row()
      .text(`${mode === "quote" ? "✓ " : ""}Quote value · USDT / USDC / …`, controlButton(ctx, { kind: "set_amount_mode", targetId: "quote", symbolId: 0 })).row()
      .text(`${mode === "base" ? "✓ " : ""}Token quantity · ETH / BTC / …`, controlButton(ctx, { kind: "set_amount_mode", targetId: "base", symbolId: 0 })).row()
      .text("‹ Terminal", "home"));
  };
  bot.callbackQuery("configuration", async ctx => { await ctx.answerCallbackQuery(); clearFlow(ctx, database); await showConfiguration(ctx); });

  const showConfirmationSettings = async (ctx: Context) => {
    const enabled = confirmationEnabled(ctx);
    await editOrReply(ctx, [terminalHeading("Order confirmation"), "",
      enabled ? "🛡 <b>Status: ON</b>" : "⚡ <b>Status: OFF</b>",
      enabled ? "Review each order before submitting." : "Orders are submitted after the last required input.",
      "Strategies still require confirmation.", "",
      "Saved for your Telegram user and current account configuration.\nA different API key defaults to ON."
    ].join("\n"), new InlineKeyboard().text(enabled ? "Disable final confirmation" : "Enable final confirmation",
      controlButton(ctx, { kind: "set_confirmation", targetId: enabled ? "off" : "on", symbolId: 0 })).row().text("‹ Configuration", "configuration"));
  };
  bot.callbackQuery("security:confirmation", async ctx => { await ctx.answerCallbackQuery(); await showConfirmationSettings(ctx); });
  bot.callbackQuery("configuration:confirmation", async ctx => { await ctx.answerCallbackQuery(); await showConfirmationSettings(ctx); });
  bot.callbackQuery(/^ordskip:([0-9a-f-]+)$/, async ctx => {
    const ids = requireIds(ctx);
    const intent = database.getIntent(ctx.match[1]!);
    if (!intent || intent.operation !== "order" || intent.chatId !== ids.chatId || intent.userId !== ids.userId
      || intent.accountContext !== accountContext || intent.status !== "previewed" || intent.expiresAt <= Date.now()) {
      await ctx.answerCallbackQuery({ text: "This confirmation is no longer active or belongs to another user.", show_alert: true }); return;
    }
    database.setOrderConfirmation(ids.chatId, ids.userId, accountContext, false);
    await ctx.answerCallbackQuery({ text: "Disabled for future orders. Confirm this order once." });
    await editOrReply(ctx, `${terminalHeading("Confirm this order")}\n\n${formatOrderDraft(intent.payload as unknown as OrderDraft)}\n${await orderFeeLine(gateway, Number(intent.payload.symbolId))}\n\nFinal confirmation is OFF for future orders. Enable it again in Configuration.\nThis order has NOT been sent. Confirm or cancel below.`,
      new InlineKeyboard().text("✅ Confirm", `confirm:o:${intent.id}`).row().text("✕ Cancel", "home"));
  });

  bot.callbackQuery(/^markets:(\d+)$/, async (ctx) => {
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) throw new Error("Trading requires a regular chat message");
    await startLiveForChat(requireIds(ctx).chatId, messageId, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^live:start(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Live updates started" });
    const ids = requireIds(ctx);
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) throw new Error("Live terminal requires a regular chat message");
    await startLiveForChat(ids.chatId, messageId, Number(ctx.match[1] ?? 0));
  });

  bot.callbackQuery(/^live:refresh(?::\d+)?$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Refreshing…" });
    await refreshLiveSession(requireIds(ctx).chatId);
  });

  bot.callbackQuery(/^live:stop(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Prices now update automatically" });
    const messageId = ctx.callbackQuery.message?.message_id;
    if (messageId) await startLiveForChat(requireIds(ctx).chatId, messageId, Number(ctx.match[1] ?? 0));
  });

  bot.callbackQuery(/^pair:(\d+)$/, async (ctx) => {
    await showPair(ctx, gateway, Number(ctx.match[1]), "5m", pair => balancesForNavigation(ctx, pair, true));
  });

  bot.callbackQuery(/^pairtf:(\d+):(1m|5m|1h|4h)$/, async (ctx) => {
    await showPair(ctx, gateway, Number(ctx.match[1]), ctx.match[2]!, pair => balancesForNavigation(ctx, pair, true));
  });

  bot.callbackQuery(/^book:(\d+):(5|10|20)$/, async (ctx) => {
    await showOrderbook(ctx, gateway, Number(ctx.match[1]), Number(ctx.match[2]));
  });

  bot.callbackQuery(/^balances(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Loading balances…" });
    const [catalog, balances] = await Promise.all([gateway.getCatalog(), gateway.listBalances()]);
    const assets = new Map(catalog.assets.map((asset) => [asset.ledgerId, asset]));
    const rows = balances.filter((balance) => balance.trading !== "0" || balance.funding !== "0" || balance.reserved !== "0")
      .sort((left, right) => {
        const leftName = assets.get(left.assetId)?.asset;
        const rightName = assets.get(right.assetId)?.asset;
        return Number(rightName === "USDT") - Number(leftName === "USDT");
      })
      .map((balance) => {
        const asset = assets.get(balance.assetId);
        const name = asset?.asset ?? `Asset #${balance.assetId}`;
        const pair = name === "USDT" ? undefined
          : catalog.pairs.find(p => p.baseAsset === name && p.quoteAsset === "USDT")
            ?? catalog.pairs.find(p => p.baseAsset === name || p.quoteAsset === name);
        return `${assetLink(name, pair?.symbol)}\nTrading total: ${numberText(scaledToDecimal(balance.trading, 18))}\nAvailable: <b>${numberText(scaledToDecimal(balance.available, 18))}</b> · Reserved: ${numberText(scaledToDecimal(balance.reserved, 18))}\nFunding: ${numberText(scaledToDecimal(balance.funding, 18))}`;
      });
    const page = Math.min(Number(ctx.match[1] ?? 0), Math.max(0, Math.ceil(rows.length / 6) - 1));
    const keyboard = new InlineKeyboard();
    if (page > 0) keyboard.text("‹ Previous", `balances:${page - 1}`);
    if ((page + 1) * 6 < rows.length) keyboard.text("Next ›", `balances:${page + 1}`);
    keyboard.row().text("📈 Trading", "markets:0").text("📋 Open orders", "orders:open").row().text("↻ Refresh balances", `balances:${page}`).text("‹ Terminal", "home");
    const note = config.tradingMode === "paper" ? "<i>These are local demo funds, not your Polyester account.</i>\n\n" : "";
    await editOrReply(ctx, `${terminalHeading("Balances")}\n${modeText(config.tradingMode)}\n\n${note}${rows.length ? rows.slice(page * 6, (page + 1) * 6).join("\n\n") : "No non-zero balances."}\n\n<i>${rows.length} assets · page ${page + 1}/${Math.max(1, Math.ceil(rows.length / 6))}</i>`, keyboard);
  });

  bot.callbackQuery("order:new", async (ctx) => {
    if (config.tradingMode === "read_only") {
      await ctx.answerCallbackQuery({ text: "Read-only mode: order creation is disabled", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    clearFlow(ctx, database);
    const catalog = await gateway.getCatalog();
    saveFlow(ctx, database, { flow: "order", step: "pair", data: {} });
    await editOrReply(ctx, "<b>New order</b>\nChoose a pair:", pairsKeyboard(catalog.pairs, 0, "ordpair", PAGE_SIZE));
  });
  bot.callbackQuery(/^ordpairpage:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const catalog = await gateway.getCatalog();
    await editOrReply(ctx, "<b>New order</b>\nChoose a pair:", pairsKeyboard(catalog.pairs, Number(ctx.match[1]), "ordpair", PAGE_SIZE));
  });
  bot.callbackQuery(/^ordpair:(\d+)$/, async (ctx) => {
    const pair = requirePair((await gateway.getCatalog()).pairs, Number(ctx.match[1]));
    saveFlow(ctx, database, { flow: "order", step: "side", data: { symbolId: pair.symbolId, symbol: pair.symbol } });
    await editOrReply(ctx, `${heading("New order")}\n${pairLink(pair.symbol)}\n${await balancesForNavigation(ctx, pair)}\n<b>Buy or sell ${escapeHtml(pair.baseAsset)}?</b>`, new InlineKeyboard().text(`🟢 Buy · ${pair.baseAsset}`, "ordside:BUY").text(`🔴 Sell · ${pair.baseAsset}`, "ordside:SELL").row().text("✕ Discard order", "cancel-flow"));
  });
  bot.callbackQuery(/^orderpairside:(\d+):(BUY|SELL)$/, async (ctx) => {
    const pair = requirePair((await gateway.getCatalog()).pairs, Number(ctx.match[1]));
    saveFlow(ctx, database, { flow: "order", step: "kind", data: { symbolId: pair.symbolId, symbol: pair.symbol, side: ctx.match[2] } });
    await showOrderKinds(ctx, pair.symbol, ctx.match[2] as OrderSide, await balancesForNavigation(ctx, pair));
  });
  bot.callbackQuery(/^ordside:(BUY|SELL)$/, async (ctx) => {
    const state = requireFlow(ctx, database, "order");
    state.data.side = ctx.match[1]; state.step = "kind"; saveFlow(ctx, database, state);
    const pair = requirePair((await gateway.getCatalog()).pairs, Number(state.data.symbolId));
    await showOrderKinds(ctx, String(state.data.symbol), ctx.match[1] as OrderSide, await balancesForNavigation(ctx, pair));
  });
  bot.callbackQuery(/^ordkind:(MARKET_IOC|LIMIT_GTC|LIMIT_GTD|LIMIT_IOC|LIMIT_FOK)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = requireFlow(ctx, database, "order");
    state.data.kind = ctx.match[1];
    const ids = requireIds(ctx);
    state.data.sizingMode = database.orderAmountMode(ids.chatId, ids.userId, accountContext);
    delete state.data.qty;
    delete state.data.maxQuoteDebit;
    delete state.data.quoteAmount;
    delete state.data.sizingPrice;
    delete state.data.balancePercent; delete state.data.percentageAsset; delete state.data.percentageBalance;
    delete state.data.inputError;
    state.step = "size";
    saveFlow(ctx, database, state);
    await requestInput(ctx, state);
  });
  bot.callbackQuery(/^ordsize:(base|quote)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = requireFlow(ctx, database, "order");
    state.data.sizingMode = ctx.match[1]; state.step = "size";
    delete state.data.balancePercent; delete state.data.percentageAsset; delete state.data.percentageBalance;
    delete state.data.qty;
    delete state.data.maxQuoteDebit;
    delete state.data.quoteAmount;
    delete state.data.sizingPrice;
    delete state.data.inputError;
    saveFlow(ctx, database, state);
    await requestInput(ctx, state);
  });
  bot.callbackQuery("order:edit:size", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = requireFlow(ctx, database, "order");
    delete state.data.inputError;
    state.step = "size";
    saveFlow(ctx, database, state);
    await requestInput(ctx, state);
  });
  bot.callbackQuery(/^ticket:/, async ctx => {
    await ctx.answerCallbackQuery({ text: "This old panel has expired. Open Trading again.", show_alert: true });
    clearFlow(ctx, database);
    await showHome(ctx, config, gateway, database, true);
  });
  bot.callbackQuery(/^ordrisk:(tp|sl|trail|slippage)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = requireFlow(ctx, database, "order");
    state.step = `risk_${ctx.match[1]}`; saveFlow(ctx, database, state);
    const pair = requirePair((await gateway.getCatalog()).pairs, Number(state.data.symbolId));
    const title = ctx.match[1] === "trail" ? "Trailing stop" : ctx.match[1] === "slippage" ? "Max. slippage" : ctx.match[1] === "tp" ? "Take-profit" : "Stop-loss";
    let prompt = [terminalHeading(title), `${pairLink(pair.symbol)} · ${escapeHtml(String(state.data.side))}`, "",
      ctx.match[1] === "trail" ? `Enter trailing distance in bps (1–10,000).\n100 bps = 1%. Optionally add an activation price in ${escapeHtml(pair.quoteAsset)}.\nExample: <code>250 90000</code>`
        : ctx.match[1] === "slippage" ? "Enter maximum slippage in bps (1–10,000).\n100 bps = 1%. Polyester validates the allowed value."
        : `Enter the trigger price in ${escapeHtml(pair.quoteAsset)} per ${escapeHtml(pair.baseAsset)}.`
    ].join("\n");
    if (!confirmationEnabled(ctx)) prompt += "\n\n⚠ <b>Confirmation OFF:</b> the order is submitted after the last required input.";
    await editOrReply(ctx, prompt, new InlineKeyboard().text("‹ Order settings", "ordoptions"));
  });
  bot.callbackQuery("ordtoggle:post", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = requireFlow(ctx, database, "order");
    state.data.postOnly = !Boolean(state.data.postOnly); saveFlow(ctx, database, state);
    await showOrderOptions(ctx, state);
  });
  bot.callbackQuery(/^ordedit:([0-9a-f-]+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const ids = requireIds(ctx);
    const intent = database.getIntent(ctx.match[1]!);
    if (!intent || intent.chatId !== ids.chatId || intent.userId !== ids.userId || intent.operation !== "order"
      || intent.expiresAt <= Date.now() || !database.transitionIntent(intent.id, ["previewed"], "superseded")) {
      throw new Error("This confirmation is no longer active. Start a new order.");
    }
    const state: WizardState = { flow: "order", step: "options", data: { ...intent.payload, inputPromptId: ctx.callbackQuery.message?.message_id } };
    saveFlow(ctx, database, state);
    await showOrderOptions(ctx, state);
  });
  bot.callbackQuery("ordoptions", async (ctx) => { await ctx.answerCallbackQuery(); await showOrderOptions(ctx, requireFlow(ctx, database, "order")); });
  bot.callbackQuery("ordpreview", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Checking order…" });
    const state = requireFlow(ctx, database, "order");
    const draft = state.data as unknown as OrderDraft;
    if (config.tradingMode === "read_only") {
      await editOrReply(ctx, `${heading("Draft review")}\n${modeText(config.tradingMode)}\n\n${formatOrderDraft(draft)}\n\n<i>Local draft only. Submission is disabled in read-only mode.</i>`, new InlineKeyboard().text("‹ Edit draft", "ticket:refresh").text("Order settings", "ordoptions").row().text("‹ Terminal", "home"));
      return;
    }
    await prepareAndShowOrderConfirmation(ctx, state);
  });
  bot.callbackQuery(/^confirm:o:([0-9a-f-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Submitting…" });
    const ids = requireIds(ctx);
    const intent = database.getIntent(ctx.match[1]!);
    if (!intent || intent.chatId !== ids.chatId || intent.userId !== ids.userId || intent.accountContext !== accountContext) throw new Error("This confirmation belongs to another user or configuration.");
    await submitOrder(ctx, intent.id, { flow: "order", step: "options", data: intent.payload });
  });

  bot.callbackQuery(/^orders:(open|history)(?::(\d+))?$/, async (ctx) => {
    const ids = requireIds(ctx);
    database.invalidateControlActions(ids.chatId, ids.userId);
    await ctx.answerCallbackQuery({ text: "Loading orders…" });
    const mode = ctx.match[1];
    const [catalog, receivedOrders] = await Promise.all([gateway.getCatalog(), mode === "open" ? gateway.listOpenOrders() : gateway.listOrderHistory()]);
    const orders = receivedOrders.filter(order => mode === "open" ? isOrderOpen(order.status) : !isOrderOpen(order.status));
    const page = Math.min(Number(ctx.match[2] ?? 0), Math.max(0, Math.ceil(orders.length / 6) - 1));
    const visible = orders.slice(page * 6, (page + 1) * 6);
    const pairMap = new Map(catalog.pairs.map((pair) => [pair.symbolId, pair.symbol]));
    const lines = visible.map((order, index) => {
      const [base = "", quote = ""] = (pairMap.get(order.symbolId) ?? "").split("-");
      return [
        `${index + 1}. ${order.side.includes("BUY") ? "🟢 BUY" : "🔴 SELL"} ${pairMap.has(order.symbolId) ? pairLink(pairMap.get(order.symbolId)!) : `#${order.symbolId}`} · ${escapeHtml(orderExecutionLabel(order.orderType, order.timeInForce))}`,
        `Status: <b>${escapeHtml(orderStatusLabel(order.status, order.raw.terminalReason))}</b>`,
        `Filled: <b>${numberText(order.cumulativeQty ?? "0")}</b> / ${numberText(order.totalQty ?? order.qty)} ${escapeHtml(base)}`,
        String(order.orderType).includes("MARKET") ? "Price: Market" : `Limit price: ${numberText(order.price)} ${escapeHtml(quote)}`
      ].join("\n");
    });
    const keyboard = new InlineKeyboard();
    for (const [index, order] of visible.entries()) {
      keyboard.text(`Order ${index + 1}`, `od:${order.orderId}`);
      if (mode === "open" && order.clientOrderId && config.tradingMode !== "read_only") keyboard.text("Cancel order", controlButton(ctx, { kind: "cancel_order_prompt", symbolId: order.symbolId, targetId: order.clientOrderId }));
      keyboard.row();
    }
    if (page > 0) keyboard.text("‹ Previous", `orders:${mode}:${page - 1}`);
    if ((page + 1) * 6 < orders.length) keyboard.text("Next ›", `orders:${mode}:${page + 1}`);
    keyboard.row();
    if (mode === "open") {
      if (config.tradingMode !== "read_only") keyboard.text("⚠️ Cancel all open orders", "oca:preview").row();
    }
    keyboard.text(mode === "open" ? "🗂 Order history" : "📋 Open orders", `orders:${mode === "open" ? "history" : "open"}`).row().text("‹ Terminal", "home");
    await editOrReply(ctx, `${terminalHeading(mode === "open" ? "Open orders" : "Order history")}\n\n${lines.length ? lines.join("\n\n") : mode === "open" ? "No open orders." : "No order history yet."}`, keyboard);
  });
  bot.callbackQuery(/^od:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Loading order details…" });
    const [catalog, details] = await Promise.all([gateway.getCatalog(), gateway.getOrderDetails(ctx.match[1]!)]);
    if (!details) {
      await editOrReply(ctx, `${terminalHeading("Order details pending")}\n\nRefresh to check the status before submitting another order.`,
        new InlineKeyboard().text("↻ Refresh order", `od:${ctx.match[1]!}`).row().text("‹ Order history", "orders:history"));
      return;
    }
    const order = details.order;
    const pair = catalog.pairs.find((item) => item.symbolId === order.symbolId);
    const total = order.totalQty ?? order.qty;
    const filled = order.cumulativeQty ?? "0";
    const remaining = order.leavesQty ?? (total ? subtractDecimals(total, filled) : undefined);
    const executionLines = details.executions.slice(0, 8).map((execution) => {
      const role = execution.liquidity ? ` · ${escapeHtml(execution.liquidity)}` : "";
      const time = execution.tsNs ? ` · ${escapeHtml(formatTimestamp(execution.tsNs))}` : "";
      return `• <code>${escapeHtml(execution.qty)} ${escapeHtml(pair?.baseAsset ?? "")} @ ${escapeHtml(execution.price)} ${escapeHtml(pair?.quoteAsset ?? "")}</code>${role}${time}`;
    });
    const keyboard = new InlineKeyboard().text("↻ Refresh order", `od:${order.orderId}`);
    if (order.clientOrderId && isOrderOpen(order.status) && config.tradingMode !== "read_only") keyboard.text("Cancel order", controlButton(ctx, { kind: "cancel_order_prompt", symbolId: order.symbolId, targetId: order.clientOrderId }));
    keyboard.row().text("‹ Open orders", "orders:open").text("Order history", "orders:history").row().text("‹ Terminal", "home");
    await editOrReply(ctx, [
      heading("Order details"), `${escapeHtml(order.side.includes("BUY") ? "BUY" : "SELL")} ${pair ? pairLink(pair.symbol) : `#${order.symbolId}`} · ${escapeHtml(orderExecutionLabel(order.orderType, order.timeInForce))}`,
      "",
      `Status: <b>${escapeHtml(orderStatusLabel(order.status, order.raw.terminalReason))}</b>`,
      order.raw.terminalReason ? `Reason: ${escapeHtml(String(order.raw.terminalReason).replaceAll("_", " "))}` : null,
      String(order.orderType).includes("MARKET") ? "Price: Market" : `Limit price: <code>${escapeHtml(order.price ?? "—")} ${escapeHtml(pair?.quoteAsset ?? "")}</code>`,
      order.averagePrice ? `Avg. fill price: <code>${escapeHtml(order.averagePrice)} ${escapeHtml(pair?.quoteAsset ?? "")}</code>` : null,
      "", "<b>◈ EXECUTION</b>",
      `Quantity: <code>${escapeHtml(total ?? "—")} ${escapeHtml(pair?.baseAsset ?? "")}</code>`,
      `Filled: <code>${escapeHtml(filled)} ${escapeHtml(pair?.baseAsset ?? "")}</code>${total ? ` · <b>${filledPercent(filled, total)}</b>` : ""}`,
      `Remaining: <code>${escapeHtml(remaining ?? "—")} ${escapeHtml(pair?.baseAsset ?? "")}</code>`,
      `Fills: <code>${details.executionCount}</code>${details.nextPageToken ? "+" : ""}`,
      "", executionLines.length ? `<b>Recent fills</b>\n${executionLines.join("\n")}` : null,
      "",
      `Order ID: <code>${escapeHtml(order.orderId)}</code>`,
      order.createdAt ? `Created: <code>${escapeHtml(formatTimestamp(order.createdAt))}</code>` : null,
      "",
      "<i>Recent fills may appear with a delay.</i>"
    ].filter(line => line !== null).join("\n"), keyboard);
  });
  // Old messages have no account/owner/expiry binding. Never execute their writes.
  bot.callbackQuery(/^(?:(?:oc|occ|tp|tr|tc|tcc):|oca:confirm$)/, async ctx => {
    await ctx.answerCallbackQuery({ text: "This button has expired. Refresh Orders or Strategies.", show_alert: true });
  });
  bot.callbackQuery("oca:preview", async (ctx) => {
    if (config.tradingMode === "read_only") { await ctx.answerCallbackQuery({ text: "Read-only mode", show_alert: true }); return; }
    await ctx.answerCallbackQuery({ text: "Checking open orders…" });
    const ids = requireIds(ctx);
    database.invalidateControlActions(ids.chatId, ids.userId);
    await gateway.cancelAll([], true, randomUUID());
    const requestId = randomUUID();
    await editOrReply(ctx, [
      "<b>⚠️ Cancel all open orders?</b>",
      "",
      "This cancels all open orders in the connected account.",
      "",
      "Orders may fill before cancellation completes."
    ].join("\n"), new InlineKeyboard().text("Confirm · cancel all", controlButton(ctx, { kind: "cancel_all", symbolId: 0, targetId: requestId })).row().text("Keep all orders", "orders:open"));
  });
  bot.callbackQuery(/^ctl:([a-f0-9-]{36})$/, async (ctx) => {
    const ids = requireIds(ctx);
    const action = database.consumeControlAction(ctx.match[1]!, ids.chatId, ids.userId, confirmationAccountContext(config));
    if (!action) { await ctx.answerCallbackQuery({ text: "This button has expired or belongs to another user or configuration. Refresh Orders or Strategies.", show_alert: true }); return; }
    await ctx.answerCallbackQuery();
    const { kind, targetId, symbolId } = action;
    if (kind === "set_confirmation") {
      database.setOrderConfirmation(ids.chatId, ids.userId, accountContext, targetId !== "off");
      await showConfirmationSettings(ctx); return;
    }
    if (kind === "set_amount_mode") {
      if (targetId !== "base" && targetId !== "quote") throw new Error("Unknown amount mode");
      database.setOrderAmountMode(ids.chatId, ids.userId, accountContext, targetId);
      database.invalidateControlActions(ids.chatId, ids.userId);
      await showConfiguration(ctx); return;
    }
    if (config.tradingMode === "read_only") return;
    if (kind === "cancel_order_prompt" || kind === "cancel_trigger_prompt") {
      const order = kind === "cancel_order_prompt";
      await ctx.reply(`Cancel ${order ? "order" : "strategy"} <code>${escapeHtml(targetId)}</code>?${order ? " It may fill before cancellation reaches the exchange." : ""}`, {
        parse_mode: "HTML", reply_markup: new InlineKeyboard()
          .text("Confirm cancellation", controlButton(ctx, { ...action, kind: order ? "cancel_order" : "cancel_trigger" }))
          .text(order ? "Keep order" : "Keep strategy", order ? "orders:open" : "triggers:list")
      });
      return;
    }
    if (kind !== "cancel_all") {
      try {
        if (kind === "cancel_order") await gateway.cancelOrder(targetId, symbolId);
        if (kind === "cancel_trigger") await gateway.cancelTrigger(targetId, symbolId);
        if (kind === "pause_trigger") await gateway.pauseTrigger(targetId, symbolId);
        if (kind === "resume_trigger") await gateway.resumeTrigger(targetId, symbolId);
      } catch {
        throw new Error("The update could not be confirmed. Refresh Orders or Strategies to check its final state before trying again.");
      }
      await ctx.reply(kind === "cancel_order" || kind === "cancel_trigger" ? "Cancellation requested. Refresh to confirm the result." : "Update requested. Refresh to confirm the result.", { reply_markup: new InlineKeyboard().text("↻ Refresh", kind === "cancel_order" ? "orders:open" : "triggers:list") });
      return;
    }
    const requestId = targetId;
    database.rememberStatus(`cancel_all:${requestId}`, "sending");
    try {
      const result = await gateway.cancelAll([], false, requestId);
      database.rememberStatus(`cancel_all:${requestId}`, `accepted:${JSON.stringify(result)}`);
      await editOrReply(ctx, "<b>Cancellation requested</b>\n\nRefresh Orders to confirm the result.", new InlineKeyboard().text("↻ Refresh orders", "orders:open").row().text("‹ Terminal", "home"));
    } catch (error) {
      database.rememberStatus(`cancel_all:${requestId}`, `unknown:${error instanceof Error ? error.message : "unknown"}`);
      throw new Error(`Cancel-all outcome is unknown for request ${requestId}. Check open orders before trying again.`);
    }
  });

  bot.callbackQuery(/^triggers:(list|history)(?::(\d+))?$/, async (ctx) => {
    const ids = requireIds(ctx);
    database.invalidateControlActions(ids.chatId, ids.userId);
    await ctx.answerCallbackQuery({ text: "Loading strategies…" });
    const [catalog, triggers] = await Promise.all([gateway.getCatalog(), gateway.listTriggers()]);
    const pairMap = new Map(catalog.pairs.map((pair) => [pair.symbolId, pair.symbol]));
    const mode = ctx.match[1]!;
    const filtered = triggers.filter(t => mode === "list" ? !/COMPLETED|CANCELED|CANCELLED|FAILED|EXPIRED/.test(t.status) : /COMPLETED|CANCELED|CANCELLED|FAILED|EXPIRED/.test(t.status));
    const page = Math.min(Number(ctx.match[2] ?? 0), Math.max(0, Math.ceil(filtered.length / 6) - 1));
    const visible = filtered.slice(page * 6, page * 6 + 6);
    const lines = visible.map((trigger, index) => `<b>${index + 1}. ${strategyKindLabel(trigger.type.replace(/^TRIGGER_TYPE_/, ""))}</b>\n${pairMap.has(trigger.symbolId) ? pairLink(pairMap.get(trigger.symbolId)!) : `#${trigger.symbolId}`}\nStatus: <b>${strategyStatusLabel(trigger.status)}</b>`);
    const keyboard = new InlineKeyboard();
    if (config.tradingMode !== "read_only") keyboard.text("＋ Create strategy", "trigger:new").row();
    visible.forEach((trigger, index) => keyboard.text(`View ${index + 1}`, `td:${trigger.triggerId}`).row());
    if (page > 0) keyboard.text("‹ Previous", `triggers:${mode}:${page - 1}`);
    if ((page + 1) * 6 < filtered.length) keyboard.text("Next ›", `triggers:${mode}:${page + 1}`);
    keyboard.row().text(mode === "list" ? "Strategy history" : "Active strategies", mode === "list" ? "triggers:history" : "triggers:list").row();
    keyboard.text("↻ Refresh strategies", `triggers:${mode}:${page}`).row().text("‹ Terminal", "home");
    await editOrReply(ctx, `${terminalHeading(mode === "history" ? "Strategy history" : "Active strategies")}\n\n${lines.length ? lines.join("\n\n") : mode === "history" ? "No strategy history yet." : "No active strategies."}`, keyboard);
  });
  bot.callbackQuery(/^td:(.+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const trigger = (await gateway.listTriggers()).find(t => t.triggerId === ctx.match[1]);
    if (!trigger) throw new Error("Strategy not found. Refresh the list.");
    const children = (await gateway.listOrderHistory()).filter(order => {
      const origin = order.raw.origin as Record<string, unknown> | undefined;
      return origin && String(origin.triggerId) === String(trigger.raw.triggerId);
    });
    const keyboard = new InlineKeyboard();
    const terminal = /COMPLETED|CANCELED|CANCELLED|FAILED|EXPIRED/.test(trigger.status);
    if (!terminal && config.tradingMode !== "read_only") {
      keyboard.text(trigger.status.includes("PAUSED") ? "Resume" : "Pause", controlButton(ctx, { kind: trigger.status.includes("PAUSED") ? "resume_trigger" : "pause_trigger", symbolId: trigger.symbolId, targetId: trigger.triggerId }))
        .text("Cancel", controlButton(ctx, { kind: "cancel_trigger_prompt", symbolId: trigger.symbolId, targetId: trigger.triggerId })).row();
    }
    keyboard.text("↻ Refresh", `td:${trigger.triggerId}`).row().text("‹ Strategies", "triggers:list");
    const pair = (await gateway.getCatalog()).pairs.find(item => item.symbolId === trigger.symbolId);
    await editOrReply(ctx, [terminalHeading("Strategy details"),
      `${strategyKindLabel(trigger.type.replace(/^TRIGGER_TYPE_/, ""))} · ${pair ? pairLink(pair.symbol) : `#${trigger.symbolId}`}`, "",
      `Status: <b>${strategyStatusLabel(trigger.status)}</b>`,
      ...(trigger.raw.failureReason || trigger.raw.cancelReason ? [`Reason: ${escapeHtml(String(trigger.raw.failureReason ?? trigger.raw.cancelReason).replace(/^TRIGGER_(?:FAILURE|CANCEL)_REASON_/, "").replaceAll("_", " "))}`] : []),
      "", "<b>GENERATED ORDERS · AVAILABLE HISTORY</b>",
      `Total: ${children.length}`, `Fully filled: ${children.filter(o => o.status.includes("FILLED") && !o.status.includes("PARTIAL")).length}`,
      `Open: ${children.filter(o => isOrderOpen(o.status)).length}`, `Rejected: ${children.filter(o => o.status.includes("REJECT")).length}`,
      ...children.slice(0, 6).map(o => `• ${escapeHtml(o.orderId)}: ${escapeHtml(orderStatusLabel(o.status, o.raw.terminalReason))}`),
      "", "Strategy completion does not mean all orders are filled.",
      !terminal && !children.length ? "No generated orders visible yet. Check again for updates." : "See Order history for execution details."
    ].join("\n"), keyboard);
  });
  bot.callbackQuery("trigger:new", async (ctx) => {
    if (config.tradingMode === "read_only") {
      await ctx.answerCallbackQuery({ text: "Read-only mode: trigger creation is disabled", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery(); clearFlow(ctx, database);
    const catalog = await gateway.getCatalog();
    saveFlow(ctx, database, { flow: "trigger", step: "pair", data: {} });
    await editOrReply(ctx, "<b>New strategy · choose a market</b>", pairsKeyboard(catalog.pairs, 0, "trpair", PAGE_SIZE));
  });
  bot.callbackQuery(/^trpairpage:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, "<b>New strategy · choose a market</b>", pairsKeyboard((await gateway.getCatalog()).pairs, Number(ctx.match[1]), "trpair", PAGE_SIZE));
  });
  bot.callbackQuery(/^trpair:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const pair = requirePair((await gateway.getCatalog()).pairs, Number(ctx.match[1]));
    saveFlow(ctx, database, { flow: "trigger", step: "kind", data: { symbolId: pair.symbolId, symbol: pair.symbol } });
    await editOrReply(ctx, `<b>${escapeHtml(pair.symbol)}</b>\nChoose strategy:`, new InlineKeyboard()
      .text("🛡 Stop-loss", "trkind:STOP_LOSS").text("🎯 Take-profit", "trkind:TAKE_PROFIT").row()
      .text("↘ Trailing stop", "trkind:TRAILING_STOP").text("⏱ TWAP · timed", "trkind:TWAP").row()
      .text("▤ Ladder · price levels", "trkind:LADDER").row().text("✕ Discard strategy", "cancel-flow"));
  });
  bot.callbackQuery(/^trkind:(STOP_LOSS|TAKE_PROFIT|TRAILING_STOP|TWAP|LADDER)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = requireFlow(ctx, database, "trigger"); state.data.kind = ctx.match[1];
    if (ctx.match[1] === "TRAILING_STOP") {
      state.data.side = "SELL"; state.data.childKind = "MARKET_IOC"; state.step = "tr_qty"; saveFlow(ctx, database, state);
      await showStrategyInput(ctx, state, "Total quantity", "Enter the {base} quantity to sell.\nTrailing stop uses market sell execution.");
    } else {
      state.step = "tr_side"; saveFlow(ctx, database, state);
      await showStrategyInput(ctx, state, "Direction", "Buy or sell {base}?", new InlineKeyboard().text("🟢 Buy", "trside:BUY").text("🔴 Sell", "trside:SELL").row().text("✕ Discard strategy", "cancel-flow"));
    }
  });
  bot.callbackQuery(/^trside:(BUY|SELL)$/, async (ctx) => {
    await ctx.answerCallbackQuery(); const state = requireFlow(ctx, database, "trigger");
    state.data.side = ctx.match[1]; state.step = "tr_qty"; saveFlow(ctx, database, state);
    await showStrategyInput(ctx, state, "Total quantity", `Enter the total {base} quantity to ${state.data.side === "BUY" ? "buy" : "sell"}${state.data.kind === "TWAP" ? " across all slices" : state.data.kind === "LADDER" ? " across all price levels" : ""}.`);
  });
  bot.callbackQuery(/^trchild:(MARKET_IOC|LIMIT_GTC)$/, async (ctx) => {
    await ctx.answerCallbackQuery(); const state = requireFlow(ctx, database, "trigger");
    state.data.childKind = ctx.match[1];
    if (ctx.match[1] === "LIMIT_GTC") {
      state.step = "tr_child_price"; saveFlow(ctx, database, state);
      await showStrategyInput(ctx, state, "Limit price", "Enter the limit price in {quote} per {base}.\nThe order remains open until filled or cancelled.");
    } else {
      state.step = "ready"; saveFlow(ctx, database, state);
      await prepareAndShowTriggerConfirmation(ctx, state);
    }
  });
  bot.callbackQuery("trpreview", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Checking strategy…" });
    await prepareAndShowTriggerConfirmation(ctx, requireFlow(ctx, database, "trigger"));
  });
  bot.callbackQuery("tredit", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = requireFlow(ctx, database, "trigger");
    const ids = requireIds(ctx);
    database.invalidateConfirmations(ids.chatId, ids.userId, "trigger");
    state.step = "tr_qty";
    saveFlow(ctx, database, state);
    await showStrategyInput(ctx, state, "Edit total quantity", "Enter the total {base} quantity.\nYou will review the strategy settings again.");
  });
  bot.callbackQuery(/^confirm:t:([0-9a-f-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Activating strategy…" });
    const ids = requireIds(ctx); const result = await trading.confirmTrigger(ctx.match[1]!, ids.chatId, ids.userId);
    const triggerId = typeof result.triggerId === "string" || typeof result.triggerId === "number" ? String(result.triggerId) : undefined;
    await editOrReply(ctx, [
      config.tradingMode === "paper" ? "<b>🧪 Paper strategy accepted</b>" : "<b>✅ Strategy accepted</b>",
      triggerId ? `Strategy ID: <code>${escapeHtml(triggerId)}</code>` : null,
      config.tradingMode === "paper" ? "Simulated strategy." : "Accepted by Polyester for automatic execution.",
      "Open Strategies to check its status and generated orders."
    ].filter(line => line !== null).join("\n"), new InlineKeyboard().text("⚡ View strategies", "triggers:list").row().text("‹ Terminal", "home"));
  });

  bot.callbackQuery("cancel-flow", async (ctx) => {
    await ctx.answerCallbackQuery(); clearFlow(ctx, database); await showHome(ctx, config, gateway, database, true);
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const state = database.getWizard(ctx.chat.id, ctx.from.id);
    if (!state) return;
    const text = ctx.message.text.trim();
    if (state.flow === "order" && ctx.message.reply_to_message && state.data.inputPromptId && ctx.message.reply_to_message.message_id !== state.data.inputPromptId) {
      await ctx.reply("That reply belongs to an older order. Use the current amount or price prompt."); return;
    }
    if (state.flow === "order" && ["size", "price", "expiry"].includes(state.step)) {
      try {
        delete state.data.inputError;
        if (state.step === "size") {
          const pair = requirePair((await gateway.getCatalog()).pairs, Number(state.data.symbolId));
          await applyOrderAmountInput(gateway, pair, state.data as unknown as OrderDraft, text, state.data.sizingMode === "quote" ? "quote" : "base");
          state.step = state.data.kind !== "MARKET_IOC" && !state.data.price ? "price" : state.data.kind === "LIMIT_GTD" && !state.data.expireAt ? "expiry" : "options";
        } else if (state.step === "price") {
          state.data.price = positiveInput(text);
          state.step = !state.data.qty && !state.data.maxQuoteDebit && !state.data.quoteAmount ? "size" : state.data.kind === "LIMIT_GTD" && !state.data.expireAt ? "expiry" : "options";
        } else {
          const minutes = Number(text);
          const expiry = /^\d+$/.test(text) && Number.isInteger(minutes) && minutes >= 1 && minutes <= 43_200 ? new Date(Date.now() + minutes * 60_000) : /^\d+$/.test(text) ? new Date(NaN) : new Date(text);
          if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) throw new Error("Choose a future expiry: 1–43200 minutes or an ISO UTC date.");
          state.data.expireAt = expiry.toISOString();
          state.step = !state.data.qty && !state.data.maxQuoteDebit && !state.data.quoteAmount ? "size" : !state.data.price ? "price" : "options";
        }
      } catch (error) { state.data.inputError = error instanceof Error ? error.message : "Invalid input"; }
      saveFlow(ctx, database, state);
      if (!state.data.inputError && state.step === "options") {
        await prepareAndShowOrderConfirmation(ctx, state);
        return;
      }
      if (["size", "price", "expiry"].includes(state.step)) await requestInput(ctx, state);
    }
    else if (state.flow === "order") {
      if (!state.step.startsWith("risk_")) return;
      await handleOrderText(ctx, state, text, database);
      if (state.step === "options") await prepareAndShowOrderConfirmation(ctx, state);
    }
    else if (state.flow === "trigger") {
      const ready = await handleTriggerText(ctx, state, text, database);
      if (ready) await prepareAndShowTriggerConfirmation(ctx, state);
    }
    else await ctx.reply("Use the confirmation buttons or /cancel.");
  });

  bot.catch(async (error) => {
    const cause = error.error;
    const message = cause instanceof GrammyError ? `Telegram API: ${cause.description}`
      : cause instanceof HttpError ? "Telegram network error"
      : cause instanceof Error ? cause.message : "Unknown error";
    logger.error("bot_update_failed", { updateId: error.ctx.update.update_id, error: message });
    const policyRequired = message.toLowerCase().includes("api_key_policy_required") || message.toLowerCase().includes("policy is required");
    const text = policyRequired
      ? [
        "<b>🔒 Polyester private data is unavailable</b>",
        "",
        "The API signature is valid, but this key has no saved access policy.",
        `Current key: <code>${escapeHtml(shorten(config.apiKeyId ?? "not configured", 22))}</code>`,
        "",
        `Open this exact key in Polyester, set <b>Balances → Read</b> and <b>Spot Trading → ${config.tradingMode === "read_only" ? "Read" : "Write"}</b>, then save/apply the policy. Keep transfers and withdrawals set to None.`
      ].join("\n")
      : `⚠️ ${escapeHtml(message)}`;
    const replyMarkup = mainKeyboard(config.tradingMode === "read_only");
    if (error.ctx.callbackQuery?.message) {
      try {
        await error.ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: replyMarkup });
        return;
      } catch {
        // Fall back to a new message only when Telegram cannot edit the callback message.
      }
    }
    await error.ctx.reply(text, { parse_mode: "HTML", reply_markup: replyMarkup }).catch(() => undefined);
  });

  return bot;
}

export async function renderTerminalSnapshot(gateway: ExchangeGateway, config: AppConfig, live: boolean, page = 0): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const [catalog, overview] = await Promise.all([gateway.getCatalog(), gateway.listMarketOverview()]);
  const markets = new Map(overview.map((item) => [item.symbolId, item]));
  const enabled = catalog.pairs.filter((pair) => pair.status === "PAIR_STATUS_ENABLED");
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(enabled.length / pageSize));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const visible = enabled.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const priceLines = visible.map((pair) => {
    const market = markets.get(pair.symbolId);
    const bps = market?.change24hBps;
    const marker = bps === null || bps === undefined ? "⚪" : bps > 0 ? "🟢" : bps < 0 ? "🔴" : "⚪";
    const change = bps === null || bps === undefined ? "—" : `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
    return `${marker} <b>${escapeHtml(pair.symbol.replace("-", " / "))}</b>\n$${numberText(market?.lastPrice)} · 24h ${escapeHtml(change)}`;
  });

  const updated = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const text = [
    terminalHeading(config.tradingMode === "read_only" ? "Markets" : "Trading"), modeText(config.tradingMode),
    "", "Select a trading pair.", "",
    ...priceLines,
    "",
    `<i>Page ${safePage + 1}/${pages} · Refresh: ${MARKET_REFRESH_MS / 1000}s\nUpdated: ${escapeHtml(updated)}</i>`
  ].join("\n");

  const keyboard = new InlineKeyboard();
  visible.forEach((pair, index) => {
    keyboard.text(pair.symbol.replace("-", "/"), `pair:${pair.symbolId}`);
    if (index % 2 === 1) keyboard.row();
  });
  if (visible.length % 2 === 1) keyboard.row();
  if (safePage > 0) keyboard.text("‹ Previous", `markets:${safePage - 1}`);
  if (safePage < pages - 1) keyboard.text("Next ›", `markets:${safePage + 1}`);
  keyboard.row();
  keyboard.text("💼 Balances", "balances").text("📋 Open orders", "orders:open").row().text("‹ Terminal", "home");
  return { text, keyboard };
}

// Display-only deadline. Trading validation and submission never use these fallbacks.
async function displayData<T>(request: Promise<T>, fallback: T, timeoutMs = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([request.catch(() => fallback), new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function showPair(ctx: Context, gateway: ExchangeGateway, symbolId: number, timeframe: string, readBalances: (pair: PairConfig) => Promise<string>): Promise<void> {
  const catalogRequest = gateway.getCatalog();
  const balancesRequest = catalogRequest.then(catalog => {
    const pair = requirePair(catalog.pairs, symbolId);
    return readBalances(pair);
  });
  const data = Promise.all([
    catalogRequest, displayData(gateway.listMarketOverview(), []),
    displayData(gateway.getOrderbook(symbolId, 5), null), displayData(gateway.getCandles(symbolId, timeframe, 32), []), balancesRequest
  ]);
  // Fast responses render once. Only show a loading panel for a perceptible delay.
  let loadingTimer: NodeJS.Timeout | undefined;
  let ready: boolean;
  try {
    ready = await Promise.race([data.then(() => true), new Promise<boolean>(resolve => {
      loadingTimer = setTimeout(() => resolve(false), 350);
    })]);
  } finally { if (loadingTimer) clearTimeout(loadingTimer); }
  if (!ready) await editOrReply(ctx, `${heading("Opening market")}\n\nLoading prices and balances…`, new InlineKeyboard().text("‹ Markets", "markets:0").text("‹ Terminal", "home"));
  const [catalog, overview, book, candles, balances] = await data;
  const pair = requirePair(catalog.pairs, symbolId);
  const market = overview.find((item) => item.symbolId === symbolId);
  const closes = [...candles].sort((a, b) => Number(a.tsSec) - Number(b.tsSec)).map((item) => Number(item.close)).filter(Number.isFinite);
  const bid = book?.bids[0]?.price ?? market?.bestBid ?? "—";
  const ask = book?.asks[0]?.price ?? market?.bestAsk ?? "—";
  const change = market?.change24hBps === null || market?.change24hBps === undefined ? "—" : `${(market.change24hBps / 100).toFixed(2)}%`;
  const keyboard = new InlineKeyboard()
    .text("1m", `pairtf:${symbolId}:1m`).text("5m", `pairtf:${symbolId}:5m`).text("1h", `pairtf:${symbolId}:1h`).text("4h", `pairtf:${symbolId}:4h`).row()
    .text("📚 Order book", `book:${symbolId}:10`).text("↻ Refresh", `pairtf:${symbolId}:${timeframe}`).row()
    .text(`🟢 Buy · ${pair.baseAsset}`, `orderpairside:${symbolId}:BUY`).text(`🔴 Sell · ${pair.baseAsset}`, `orderpairside:${symbolId}:SELL`).row()
    .text("‹ Markets", "markets:0").text("‹ Terminal", "home");
  await editOrReply(ctx, [
    heading("Market overview"), pairLink(pair.symbol), "",
    `Last price: <b>${pair.quoteAsset === "USDT" ? "$" : ""}${numberText(market?.lastPrice)} ${escapeHtml(pair.quoteAsset)}</b> · 24h ${escapeHtml(change)}`, "",
    "<b>▥ MARKET</b>",
    `Bid: ${numberText(bid)} · Ask: ${numberText(ask)} ${escapeHtml(pair.quoteAsset)}`,
    `24h low / high: ${numberText(market?.low24h)} / ${numberText(market?.high24h)} ${escapeHtml(pair.quoteAsset)}`,
    `24h volume: ${numberText(market?.volume24hBase)} ${escapeHtml(pair.baseAsset)}`, "",
    `<b>💗 CHART · ${escapeHtml(timeframe)}</b>`, closes.length ? `<code>${sparkline(closes)}</code>` : "Chart unavailable · use Refresh to try again",
    balances,
    `Min. quantity: ${numberText(pair.minQtyBase)} ${escapeHtml(pair.baseAsset)}`,
    `Min. order value: ${numberText(pair.minNotionalQuote)} ${escapeHtml(pair.quoteAsset)}`
  ].join("\n"), keyboard);
}

async function showOrderbook(ctx: Context, gateway: ExchangeGateway, symbolId: number, depth: number): Promise<void> {
  const [catalog, book] = await Promise.all([gateway.getCatalog(), gateway.getOrderbook(symbolId, depth)]);
  const pair = requirePair(catalog.pairs, symbolId);
  const body = [
    heading("Order book"), pairLink(pair.symbol),
    "",
    `Price (${escapeHtml(pair.quoteAsset)}) │ Quantity (${escapeHtml(pair.baseAsset)})`,
    orderBookTable(book.asks.slice(0, depth), book.bids.slice(0, depth)),
    "<i>Asks above · Bids below</i>"
  ].join("\n");
  await editOrReply(ctx, body, new InlineKeyboard()
    .text("5 levels", `book:${symbolId}:5`).text("10 levels", `book:${symbolId}:10`).text("20 levels", `book:${symbolId}:20`).row()
    .text("↻ Refresh book", `book:${symbolId}:${depth}`).row()
    .text(`🟢 Buy · ${pair.baseAsset}`, `orderpairside:${symbolId}:BUY`).text(`🔴 Sell · ${pair.baseAsset}`, `orderpairside:${symbolId}:SELL`).row()
    .text("‹ Pair overview", `pair:${symbolId}`).text("‹ Markets", "markets:0"));
}

function subtractDecimals(left: string, right: string): string {
  const scale = Math.max(left.split(".")[1]?.length ?? 0, right.split(".")[1]?.length ?? 0);
  const result = BigInt(decimalToScaled(left, scale)) - BigInt(decimalToScaled(right, scale));
  return scaledToDecimal(result < 0n ? 0n : result, scale);
}

function filledPercent(filled: string, total: string): string {
  const scale = Math.max(filled.split(".")[1]?.length ?? 0, total.split(".")[1]?.length ?? 0);
  const numerator = BigInt(decimalToScaled(filled, scale));
  const denominator = BigInt(decimalToScaled(total, scale));
  if (denominator === 0n) return "0.00%";
  const hundredths = numerator * 10_000n / denominator;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}%`;
}

function formatTimestamp(value: string): string {
  try {
    if (/^\d+$/.test(value)) {
      const raw = BigInt(value);
      const milliseconds = raw > 9_999_999_999_999n ? raw / 1_000_000n : raw;
      return new Date(Number(milliseconds)).toISOString();
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
  } catch {
    return value;
  }
}

function isOrderOpen(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized.includes("open") || normalized.includes("working") || normalized.includes("partial") || normalized.includes("accepted");
}

function orderStatusLabel(status: string, reason?: unknown): string {
  if (String(reason).includes("GTD_EXPIRED")) return "Expired";
  if (String(reason).includes("POST_ONLY_CROSS")) return "Rejected · post-only price crosses the book";
  const value = status.replace(/^ORDER_STATUS_/, "").toUpperCase();
  if (value.includes("PARTIAL")) return "Partially filled";
  if (value.includes("FILLED")) return "Filled";
  if (value.includes("CANCEL")) return "Cancelled";
  if (value.includes("REJECT")) return "Rejected";
  if (value.includes("EXPIRED")) return "Expired";
  if (value.includes("OPEN") || value.includes("WORKING") || value.includes("ACCEPTED")) return "Open · waiting for fill";
  return value.replaceAll("_", " ").toLowerCase().replace(/^./, character => character.toUpperCase());
}

function orderExecutionLabel(orderType?: string, timeInForce?: string): string {
  const type = String(orderType ?? "").toUpperCase();
  const tif = String(timeInForce ?? "").toUpperCase();
  if (type.includes("MARKET")) return "Market";
  if (tif.includes("GTC")) return "Limit GTC";
  if (tif.includes("GTD")) return "Limit GTD";
  if (tif.includes("FOK")) return "Limit FOK";
  if (tif.includes("IOC")) return "Limit IOC";
  return [orderType, timeInForce].filter(Boolean).join(" / ") || "Not reported";
}

function strategyStatusLabel(status: string): string {
  return escapeHtml(status.replace(/^(?:TRIGGER_)?STATUS_/, "").replaceAll("_", " ").toLowerCase().replace(/^./, c => c.toUpperCase()));
}

async function showStrategyInput(ctx: Context, state: WizardState, title: string, instruction: string, keyboard?: InlineKeyboard): Promise<void> {
  await editOrReply(ctx, strategyPrompt(state.data as unknown as TriggerDraft, title, instruction),
    keyboard ?? new InlineKeyboard().text("✕ Discard strategy", "cancel-flow"));
}

async function handleOrderText(ctx: Context & { message: { text: string }; chat: { id: number }; from: { id: number } }, state: WizardState, text: string, db: AppDatabase): Promise<void> {
  if (state.step === "size") {
    assertDecimal(text);
    if (state.data.sizingMode === "quote") state.data.maxQuoteDebit = text; else state.data.qty = text;
    if (state.data.kind !== "MARKET_IOC") { state.step = "price"; db.saveWizard(ctx.chat.id, ctx.from.id, state); await ctx.reply("Send limit price:"); return; }
    state.step = "options"; db.saveWizard(ctx.chat.id, ctx.from.id, state); await showOrderOptions(ctx, state); return;
  }
  if (state.step === "price") {
    assertDecimal(text); state.data.price = text;
    if (state.data.kind === "LIMIT_GTD") { state.step = "expiry"; db.saveWizard(ctx.chat.id, ctx.from.id, state); await ctx.reply("Send expiry as minutes from now (1–43200), or ISO UTC timestamp:"); return; }
    state.step = "options"; db.saveWizard(ctx.chat.id, ctx.from.id, state); await showOrderOptions(ctx, state); return;
  }
  if (state.step === "expiry") {
    const minutes = Number(text);
    const expiry = Number.isInteger(minutes) && minutes >= 1 && minutes <= 43_200 ? new Date(Date.now() + minutes * 60_000) : new Date(text);
    if (!Number.isFinite(expiry.getTime())) throw new Error("Invalid expiry time");
    state.data.expireAt = expiry.toISOString(); state.step = "options"; db.saveWizard(ctx.chat.id, ctx.from.id, state); await showOrderOptions(ctx, state); return;
  }
  if (state.step.startsWith("risk_")) {
    const risk = (state.data.attachedRisk as Record<string, unknown> | undefined) ?? {};
    if (state.step === "risk_tp") { assertDecimal(text); risk.takeProfitPrice = text; }
    if (state.step === "risk_sl") {
      assertDecimal(text); risk.stopLossPrice = text;
      delete risk.trailingBps; delete risk.trailingDistance; delete risk.activationPrice;
    }
    if (state.step === "risk_trail") {
      const [bpsText, activationPrice, extra] = text.split(/\s+/);
      if (extra) throw new Error("Send trailing bps and, optionally, one activation price");
      risk.trailingBps = assertInteger(bpsText!, 1, 10_000);
      if (activationPrice) { assertDecimal(activationPrice); risk.activationPrice = activationPrice; }
      else delete risk.activationPrice;
      delete risk.stopLossPrice; delete risk.trailingDistance;
    }
    if (state.step === "risk_slippage") state.data.maxSlippageBps = assertInteger(text, 1, 10_000);
    state.data.attachedRisk = risk; state.step = "options"; db.saveWizard(ctx.chat.id, ctx.from.id, state); return;
  }
  await ctx.reply("Use the buttons in the current wizard or /cancel.");
}

async function handleTriggerText(ctx: Context & { message: { text: string }; chat: { id: number }; from: { id: number } }, state: WizardState, text: string, db: AppDatabase): Promise<boolean> {
  if (state.step === "tr_qty") {
    assertDecimal(text); state.data.qty = text;
    if (state.data.kind === "STOP_LOSS" || state.data.kind === "TAKE_PROFIT") state.step = "tr_trigger_price";
    else if (state.data.kind === "TRAILING_STOP") state.step = "tr_trailing_bps";
    else if (state.data.kind === "TWAP") state.step = "tr_duration";
    else state.step = "tr_price_min";
    db.saveWizard(ctx.chat.id, ctx.from.id, state);
    const prompt = state.step === "tr_trigger_price" ? ["Trigger price", "Enter the trigger price in {quote} per {base}."]
      : state.step === "tr_trailing_bps" ? ["Trailing distance", "Enter distance in bps (1–10,000).\n100 bps = 1%."]
      : state.step === "tr_duration" ? ["Duration", "Enter the total execution duration in seconds (1–86,400)."]
      : ["Lower price", "Enter the lowest order price in {quote} per {base}."];
    await showStrategyInput(ctx, state, prompt[0]!, prompt[1]!); return false;
  }
  if (state.step === "tr_trigger_price") {
    assertDecimal(text); state.data.triggerPrice = text; state.step = "tr_child"; db.saveWizard(ctx.chat.id, ctx.from.id, state);
    if (state.data.side === "BUY") {
      await showStrategyInput(ctx, state, "Order type", "Conditional buys use limit orders.\nThe order remains open until filled or cancelled.", new InlineKeyboard().text("Set limit price", "trchild:LIMIT_GTC").row().text("✕ Discard strategy", "cancel-flow"));
    } else {
      await showStrategyInput(ctx, state, "Order type", "Choose how the triggered order executes.", new InlineKeyboard().text("Market · execute immediately", "trchild:MARKET_IOC").row().text("Limit GTC", "trchild:LIMIT_GTC").row().text("✕ Discard strategy", "cancel-flow"));
    }
    return false;
  }
  if (state.step === "tr_trailing_bps") {
    state.data.trailingBps = assertInteger(text, 1, 10_000); state.step = "tr_activation"; db.saveWizard(ctx.chat.id, ctx.from.id, state);
    await showStrategyInput(ctx, state, "Activation price", "Enter a price in {quote}, or 0 to start tracking immediately."); return false;
  }
  if (state.step === "tr_activation") {
    if (text !== "0") { assertDecimal(text); state.data.activationPrice = text; }
    else delete state.data.activationPrice;
    state.step = "tr_trailing_slippage"; db.saveWizard(ctx.chat.id, ctx.from.id, state);
    await showStrategyInput(ctx, state, "Max. slippage", "Enter maximum slippage in bps (0–10,000).\n100 bps = 1%. Use 0 for the Polyester default.\nPolyester validates the allowed value before activation."); return false;
  }
  if (state.step === "tr_trailing_slippage") {
    const value = assertInteger(text, 0, 10_000);
    if (value > 0) state.data.maxSlippageBps = value; else delete state.data.maxSlippageBps;
    state.step = "ready"; db.saveWizard(ctx.chat.id, ctx.from.id, state); return true;
  }
  if (state.step === "tr_duration") {
    state.data.durationMs = assertInteger(text, 1, 86_400) * 1000; state.step = "tr_interval"; db.saveWizard(ctx.chat.id, ctx.from.id, state);
    await showStrategyInput(ctx, state, "Slice interval", "Enter seconds between orders (1–86,400)."); return false;
  }
  if (state.step === "tr_interval") {
    state.data.sliceIntervalMs = assertInteger(text, 1, 86_400) * 1000; state.step = "tr_child"; db.saveWizard(ctx.chat.id, ctx.from.id, state);
    await showStrategyInput(ctx, state, "Order type", "Choose how each timed slice executes.", new InlineKeyboard().text("Market · execute now", "trchild:MARKET_IOC").row().text("Limit GTC", "trchild:LIMIT_GTC").row().text("✕ Discard strategy", "cancel-flow")); return false;
  }
  if (state.step === "tr_price_min") { assertDecimal(text); state.data.priceMin = text; state.step = "tr_price_max"; db.saveWizard(ctx.chat.id, ctx.from.id, state); await showStrategyInput(ctx, state, "Upper price", "Enter the highest order price in {quote} per {base}."); return false; }
  if (state.step === "tr_price_max") { assertDecimal(text); state.data.priceMax = text; state.step = "tr_levels"; db.saveWizard(ctx.chat.id, ctx.from.id, state); await showStrategyInput(ctx, state, "Price levels", "Enter the number of orders: 2–100."); return false; }
  if (state.step === "tr_levels") { state.data.levels = assertInteger(text, 2, 100); state.data.childKind = "LIMIT_GTC"; state.data.postOnly = false; state.step = "ready"; db.saveWizard(ctx.chat.id, ctx.from.id, state); return true; }
  if (state.step === "tr_child_price") { assertDecimal(text); state.data.childLimitPrice = text; state.step = "ready"; db.saveWizard(ctx.chat.id, ctx.from.id, state); return true; }
  await ctx.reply("Use the buttons in the current wizard or /cancel.");
  return false;
}

async function showHome(ctx: Context, config: AppConfig, gateway: ExchangeGateway, database: AppDatabase, edit = false): Promise<void> {
  const text = await renderOverview(gateway, config, database, ctx.from?.id);
  if (edit) {
    await editOrReply(ctx, text, mainKeyboard(config.tradingMode === "read_only"));
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: mainKeyboard(config.tradingMode === "read_only")
    });
  }
}

async function showOrderKinds(ctx: Context, symbol: string, side?: OrderSide, balances = ""): Promise<void> {
  await editOrReply(ctx, orderKindCard(symbol, side, balances), orderKindKeyboard());
}

async function showOrderOptions(ctx: Context, state: WizardState): Promise<void> {
  const draft = state.data as unknown as Partial<OrderDraft>;
  await editOrReply(ctx, orderSettingsCard(draft), orderOptionsKeyboard(draft));
}

async function editOrReply(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  if (ctx.callbackQuery?.message) {
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }); return; }
    catch (error) {
      if (error instanceof GrammyError && error.description.includes("message is not modified")) return;
      if (!(error instanceof GrammyError) || !/message to edit not found|message can't be edited/i.test(error.description)) throw error;
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

function requireIds(ctx: Context): { chatId: number; userId: number } {
  if (!ctx.chat?.id || !ctx.from?.id) throw new Error("Missing Telegram identity");
  return { chatId: ctx.chat.id, userId: ctx.from.id };
}

function saveFlow(ctx: Context, db: AppDatabase, state: WizardState): void { const ids = requireIds(ctx); db.saveWizard(ids.chatId, ids.userId, state); }
function clearFlow(ctx: Context, db: AppDatabase): void { const ids = requireIds(ctx); db.clearWizard(ids.chatId, ids.userId); db.invalidateConfirmations(ids.chatId, ids.userId); db.invalidateControlActions(ids.chatId, ids.userId); }
function requireFlow(ctx: Context, db: AppDatabase, flow: "order" | "trigger" | "cancel_all"): WizardState {
  const ids = requireIds(ctx); const state = db.getWizard(ids.chatId, ids.userId);
  if (!state || state.flow !== flow) throw new Error("This input panel is no longer active. Use the latest confirmation or start a new order.");
  return state;
}
function requirePair(pairs: PairConfig[], symbolId: number): PairConfig { const pair = pairs.find((item) => item.symbolId === symbolId); if (!pair) throw new Error("Unknown trading pair"); return pair; }
function assertDecimal(value: string): void { if (!DECIMAL.test(value) || Number(value) <= 0) throw new Error("Send a positive decimal number using a dot"); }
function assertInteger(value: string, min: number, max: number): number { const number = Number(value); if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Send an integer from ${min} to ${max}`); return number; }
