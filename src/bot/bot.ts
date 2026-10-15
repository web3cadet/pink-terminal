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
import { formatOrderDraft, formatTriggerDraft, mainKeyboard, orderKindCard, orderKindKeyboard, orderOptionsKeyboard, pairsKeyboard, sparkline } from "./ui.js";
import { renderOverview } from "./overview.js";
import { orderBalances, orderMinimums, orderFeeLine } from "./order-context.js";
import { resolveQuoteAmount } from "./order-sizing.js";
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
  const renderOrderPanel = async (ctx: Context, state: WizardState, text: string, keyboard: InlineKeyboard) => {
    const messageId = ctx.callbackQuery?.message?.message_id ?? Number(state.data.inputPromptId);
    if (Number.isSafeInteger(messageId) && messageId > 0) {
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
      state.step === "expiry" ? "Enter the number of minutes until expiry."
        : state.step === "price" ? `<b>Enter the limit price in ${currency} per ${base}.</b>\nPrice step: ${escapeHtml(pair.tickSize)}.`
        : [
          quote ? `<b>Enter the amount in ${currency} to ${sell ? "sell" : "buy"} ${base} for.</b>`
            : `<b>Enter the quantity of ${base} to ${sell ? "sell" : "buy"}.</b>`,
          quote ? `For example, 100 = ${sell ? "sell" : "buy"} about 100 ${currency} worth of ${base}, before Fee.` : `For example, 1 = 1 ${base}.`,
          "", orderMinimums(pair), "", "Send a number in this chat."
        ].join("\n")
    ].join("\n");
    const keyboard = new InlineKeyboard();
    if (state.step === "size") keyboard.text(quote ? `Enter in ${pair.baseAsset} instead` : `Enter in ${pair.quoteAsset} instead`, quote ? "ordsize:base" : "ordsize:quote").row();
    keyboard.text("⚙ Optional settings", "ordoptions").row().text("✕ Cancel order", "cancel-flow");
    if (!confirmationEnabled(ctx)) prompt += "\n\n⚡ <b>Final confirmation is OFF.</b> Completing the required fields submits the order immediately.";
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
        receipt.status === "paper" ? "<b>🧪 Paper order accepted</b>" : "<b>✅ Order admitted</b>",
        formatOrderDraft(state.data as unknown as OrderDraft),
        `Order: <code>${escapeHtml(receipt.orderId ?? "pending")}</code>`,
        "Admission is not a fill. Check Orders for final state."
      ].join("\n");
    } catch (error) {
      logger.warn("order_submission_needs_review", { error: error instanceof Error ? error.message : "unknown" });
      result = `${terminalHeading("Check order status")}\n\n${escapeHtml(error instanceof Error ? error.message : "Submission could not be confirmed.")}\n\nCheck Orders before trying again. This order will not be retried automatically.`;
    }
    await renderOrderPanel(ctx, state, result, new InlineKeyboard().text("📋 Open orders", "orders:open").row().text("‹ Overview", "home"));
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
        "<blockquote>✅ <b>Checked by Polyester</b>\nThe order is valid. Nothing has been sent yet.</blockquote>",
        config.tradingMode === "paper" ? "🧪 <b>PAPER MODE:</b> confirmation creates a simulated order." : "⚠️ <b>Confirm once to submit this live testnet order.</b>",
        `Confirmation expires at <code>${new Date(prepared.expiresAt).toISOString()}</code>.`,
        "<i>Don't show again disables this screen for future orders. This order still needs Confirm.</i>"
      ].join("\n");
      const keyboard = new InlineKeyboard()
        .text(shorten(`✅ Confirm ${side} · ${spend}`, 58), `confirm:o:${prepared.id}`).row()
        .text("✕ Cancel order", "home").row()
        .text("Don't show again", `ordskip:${prepared.id}`);

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
      keyboard.text("✕ Cancel order", "cancel-flow");
      await renderOrderPanel(ctx, state, [
        terminalHeading("Order needs attention"),
        pair ? pairLink(pair.symbol) : "",
        pair ? await orderBalances(gateway, pair) : "Balances unavailable",
        "",
        `⚠️ ${escapeHtml(String(state.data.inputError))}`,
        "",
        "No order was sent. Change the amount or cancel the order."
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
        "<blockquote>✅ <b>Strategy is ready</b>\nNothing has been sent yet. After confirmation, Polyester will monitor and execute it automatically.</blockquote>",
        config.tradingMode === "paper" ? "🧪 <b>PAPER MODE:</b> activation will be simulated." : "⚠️ <b>Confirm once to activate this live testnet strategy.</b>",
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
      ].join("\n"), new InlineKeyboard().text("↻ Check again", "trpreview").row().text("✕ Discard strategy", "cancel-flow"));
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
      if (snapshot.text !== session.lastText) {
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
    // Serialize updates from this chat so repeated amount messages cannot create two immediate orders.
    const previous = chatUpdates.get(chatId);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    chatUpdates.set(chatId, current);
    await previous;
    try {
      const callbackData = ctx.callbackQuery?.data;
      if (ctx.message?.text?.startsWith("/") || callbackData === "home" || callbackData === "markets:0") clearFlow(ctx, database);
      if ((callbackData && !callbackData.startsWith("live:")) || ctx.message) await stopLiveForChat(chatId);
      await next();
    } finally {
      release();
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
      "<b>Trading</b> — choose a market and enter the amount. Confirm once, unless you disabled final confirmation in Security.",
      "<b>Strategies</b> — configure the required values and confirm once; accepted strategies then run automatically on Polyester.",
      "<b>Orders</b> — inspect fill progress or cancel open orders.",
      "",
      "The bot is self-hosted. API secrets stay in your local <code>.env</code> and must never be sent through Telegram.",
      "",
      `<a href="${WEBSITE}">Open Polyester testnet ↗</a>\nUse /cancel to leave any unfinished action.`
    ].join("\n"), mainKeyboard(config.tradingMode === "read_only"));
  });

  bot.callbackQuery("safety", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, [
      terminalHeading("Security & mode"), "",
      config.tradingMode === "live" ? "🟢 <b>LIVE TESTNET</b> · signed trading is enabled"
        : config.tradingMode === "paper" ? "🧪 <b>PAPER</b> · transactions are simulated"
        : "🔒 <b>READ ONLY</b> · writes are blocked",
      `API connection: <b>${config.apiKeyId && config.apiSecretHex ? "connected" : "not configured"}</b>`,
      `Final confirmation: <b>${confirmationEnabled(ctx) ? "ON" : "OFF · immediate submission"}</b>`,
      `Final confirmation remains valid for <b>${config.confirmationTtlSeconds} seconds</b>.`,
      "",
      "This interface has no withdrawal action. Effective permissions are controlled by the policy attached to your Polyester API key."
    ].join("\n"), new InlineKeyboard().text("Order confirmation", "security:confirmation").row().text("‹ Overview", "home"));
  });

  const showConfirmationSettings = async (ctx: Context) => {
    const enabled = confirmationEnabled(ctx);
    await editOrReply(ctx, [terminalHeading("Order confirmation"), "",
      enabled ? "🛡 <b>Final confirmation: ON</b>" : "⚡ <b>Final confirmation: OFF</b>",
      enabled ? "Review each order and press Confirm to submit it." : "Completing the order fields submits it immediately after validation. There is no final review screen.",
      "", "This setting applies to your regular orders, not strategies. API validation and access checks remain active.",
      "Saved for your Telegram user and current API configuration. A different key defaults to confirmation ON."
    ].join("\n"), new InlineKeyboard().text(enabled ? "Disable final confirmation" : "Enable final confirmation",
      controlButton(ctx, { kind: "set_confirmation", targetId: enabled ? "off" : "on", symbolId: 0 })).row().text("‹ Security", "safety"));
  };
  bot.callbackQuery("security:confirmation", async ctx => { await ctx.answerCallbackQuery(); await showConfirmationSettings(ctx); });
  bot.callbackQuery(/^ordskip:([0-9a-f-]+)$/, async ctx => {
    const ids = requireIds(ctx);
    const intent = database.getIntent(ctx.match[1]!);
    if (!intent || intent.operation !== "order" || intent.chatId !== ids.chatId || intent.userId !== ids.userId
      || intent.accountContext !== accountContext || intent.status !== "previewed" || intent.expiresAt <= Date.now()) {
      await ctx.answerCallbackQuery({ text: "This confirmation is no longer active or belongs to another user.", show_alert: true }); return;
    }
    database.setOrderConfirmation(ids.chatId, ids.userId, accountContext, false);
    await ctx.answerCallbackQuery({ text: "Disabled for future orders. Confirm this order once." });
    await editOrReply(ctx, `${terminalHeading("Confirm this order")}\n\n${formatOrderDraft(intent.payload as unknown as OrderDraft)}\n${await orderFeeLine(gateway, Number(intent.payload.symbolId))}\n\nFinal confirmation is OFF for future orders. Enable it again in Security.\nThis order has NOT been sent. Confirm or cancel below.`,
      new InlineKeyboard().text("✅ Confirm", `confirm:o:${intent.id}`).row().text("✕ Cancel", "home"));
  });

  bot.callbackQuery(/^markets:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Live prices loading…" });
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
    await ctx.answerCallbackQuery({ text: "Loading market…" });
    await showPair(ctx, gateway, Number(ctx.match[1]), "5m");
  });

  bot.callbackQuery(/^pairtf:(\d+):(1m|5m|1h|4h)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: `Loading ${ctx.match[2]} chart…` });
    await showPair(ctx, gateway, Number(ctx.match[1]), ctx.match[2]!);
  });

  bot.callbackQuery(/^book:(\d+):(5|10|20)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Loading order book…" });
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
        return `${assetLink(name, pair?.symbol)}\nAvailable  <b>${numberText(scaledToDecimal(balance.available, 18))}</b>\nTrading  ${numberText(scaledToDecimal(balance.trading, 18))}  ·  Locked  ${numberText(scaledToDecimal(balance.reserved, 18))}\nFunding  ${numberText(scaledToDecimal(balance.funding, 18))}`;
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
    await editOrReply(ctx, "<b>New order · 1/5</b>\nChoose a pair:", pairsKeyboard(catalog.pairs, 0, "ordpair", PAGE_SIZE));
  });
  bot.callbackQuery(/^ordpairpage:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const catalog = await gateway.getCatalog();
    await editOrReply(ctx, "<b>New order · 1/5</b>\nChoose a pair:", pairsKeyboard(catalog.pairs, Number(ctx.match[1]), "ordpair", PAGE_SIZE));
  });
  bot.callbackQuery(/^ordpair:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const pair = requirePair((await gateway.getCatalog()).pairs, Number(ctx.match[1]));
    saveFlow(ctx, database, { flow: "order", step: "side", data: { symbolId: pair.symbolId, symbol: pair.symbol } });
    await editOrReply(ctx, `${heading("New order · direction")}\n${pairLink(pair.symbol)}\n\n${await orderBalances(gateway, pair)}\n\n<b>What do you want to do?</b>`, new InlineKeyboard().text(`🟢 Buy · ${pair.baseAsset}`, "ordside:BUY").text(`🔴 Sell · ${pair.baseAsset}`, "ordside:SELL").row().text("✕ Cancel order", "cancel-flow"));
  });
  bot.callbackQuery(/^orderpairside:(\d+):(BUY|SELL)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const pair = requirePair((await gateway.getCatalog()).pairs, Number(ctx.match[1]));
    saveFlow(ctx, database, { flow: "order", step: "kind", data: { symbolId: pair.symbolId, symbol: pair.symbol, side: ctx.match[2] } });
    await showOrderKinds(ctx, pair.symbol, ctx.match[2] as OrderSide, await orderBalances(gateway, pair));
  });
  bot.callbackQuery(/^ordside:(BUY|SELL)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = requireFlow(ctx, database, "order");
    state.data.side = ctx.match[1]; state.step = "kind"; saveFlow(ctx, database, state);
    const pair = requirePair((await gateway.getCatalog()).pairs, Number(state.data.symbolId));
    await showOrderKinds(ctx, String(state.data.symbol), ctx.match[1] as OrderSide, await orderBalances(gateway, pair));
  });
  bot.callbackQuery(/^ordkind:(MARKET_IOC|LIMIT_GTC|LIMIT_GTD|LIMIT_IOC|LIMIT_FOK)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = requireFlow(ctx, database, "order");
    state.data.kind = ctx.match[1];
    state.data.sizingMode = "quote";
    delete state.data.qty;
    delete state.data.maxQuoteDebit;
    delete state.data.quoteAmount;
    delete state.data.sizingPrice;
    delete state.data.inputError;
    state.step = "size";
    saveFlow(ctx, database, state);
    await requestInput(ctx, state);
  });
  bot.callbackQuery(/^ordsize:(base|quote)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = requireFlow(ctx, database, "order");
    state.data.sizingMode = ctx.match[1]; state.step = "size";
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
    const prompt = ctx.match[1] === "trail" ? "Send trailing distance in bps (1–10000), optionally followed by activation price. Example: <code>250 90000</code>"
      : ctx.match[1] === "slippage" ? "Send this order's maximum slippage in bps (1–10000; 100 = 1%):"
      : `Send ${ctx.match[1] === "tp" ? "take-profit" : "stop-loss"} trigger price:`;
    await editOrReply(ctx, prompt, new InlineKeyboard().text("‹ Risk controls", "ordoptions"));
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
      await editOrReply(ctx, `${heading("Draft review")}\n${modeText(config.tradingMode)}\n\n${formatOrderDraft(draft)}\n\n<i>Local draft only. Submission is disabled in read-only mode.</i>`, new InlineKeyboard().text("‹ Edit draft", "ticket:refresh").text("Risk controls", "ordoptions").row().text("‹ Overview", "home"));
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
    const lines = visible.map((order, index) => [
      `${index + 1}. ${pairMap.has(order.symbolId) ? pairLink(pairMap.get(order.symbolId)!) : `#${order.symbolId}`} · ${order.side.includes("BUY") ? "🟢" : "🔴"} ${escapeHtml(order.side)}`,
      `<b>${escapeHtml(orderStatusLabel(order.status, order.raw.terminalReason))}</b>`,
      `Filled  <b>${numberText(order.cumulativeQty ?? "0")}</b> / ${numberText(order.totalQty ?? order.qty)}`,
      `Price  ${numberText(order.price ?? "Market")}`,
      `ID <code>${escapeHtml(shorten(order.orderId, 16))}</code>`
    ].join("\n"));
    const keyboard = new InlineKeyboard();
    for (const [index, order] of visible.entries()) {
      keyboard.text(`View order · ${index + 1}`, `od:${order.orderId}`);
      if (mode === "open" && order.clientOrderId && config.tradingMode !== "read_only") keyboard.text("Cancel order", controlButton(ctx, { kind: "cancel_order_prompt", symbolId: order.symbolId, targetId: order.clientOrderId }));
      keyboard.row();
    }
    if (page > 0) keyboard.text("‹ Previous", `orders:${mode}:${page - 1}`);
    if ((page + 1) * 6 < orders.length) keyboard.text("Next ›", `orders:${mode}:${page + 1}`);
    keyboard.row();
    if (mode === "open") {
      if (config.tradingMode !== "read_only") keyboard.text("⚠️ Cancel all open orders", "oca:preview").row();
    }
    keyboard.text(mode === "open" ? "🗂 Order history" : "📋 Open orders", `orders:${mode === "open" ? "history" : "open"}`).row().text("‹ Overview", "home");
    const explanation = mode === "open"
      ? "Orders still waiting for a fill. Open one to inspect its executed and remaining amount."
      : "Filled, cancelled, rejected, and previous orders. Open one to inspect its final status and fills.";
    await editOrReply(ctx, `${terminalHeading(mode === "open" ? "Open orders" : "Order history")}\n<i>${explanation}</i>\n\n${lines.length ? lines.join("\n\n") : mode === "open" ? "<b>No open orders</b>\nThere is nothing waiting to fill." : "<b>No order history yet</b>\nCompleted, cancelled, or rejected orders will appear here."}`, keyboard);
  });
  bot.callbackQuery(/^od:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Loading order details…" });
    const [catalog, details] = await Promise.all([gateway.getCatalog(), gateway.getOrderDetails(ctx.match[1]!)]);
    if (!details) throw new Error("Order was not found");
    const order = details.order;
    const pair = catalog.pairs.find((item) => item.symbolId === order.symbolId);
    const total = order.totalQty ?? order.qty;
    const filled = order.cumulativeQty ?? "0";
    const remaining = order.leavesQty ?? (total ? subtractDecimals(total, filled) : undefined);
    const executionLines = details.executions.slice(0, 8).map((execution) => {
      const role = execution.liquidity ? ` · ${escapeHtml(execution.liquidity)}` : "";
      const time = execution.tsNs ? ` · ${escapeHtml(formatTimestamp(execution.tsNs))}` : "";
      return `• <code>${escapeHtml(execution.qty)} @ ${escapeHtml(execution.price)}</code>${role}${time}`;
    });
    const keyboard = new InlineKeyboard().text("↻ Refresh order", `od:${order.orderId}`);
    if (order.clientOrderId && isOrderOpen(order.status) && config.tradingMode !== "read_only") keyboard.text("Cancel order", controlButton(ctx, { kind: "cancel_order_prompt", symbolId: order.symbolId, targetId: order.clientOrderId }));
    keyboard.row().text("‹ Open orders", "orders:open").text("Order history", "orders:history").row().text("‹ Overview", "home");
    await editOrReply(ctx, [
      heading("Order details"), pair ? pairLink(pair.symbol) : `#${order.symbolId}`,
      "",
      `Status: <b>${escapeHtml(orderStatusLabel(order.status, order.raw.terminalReason))}</b>`,
      order.raw.terminalReason ? `Reason: ${escapeHtml(String(order.raw.terminalReason).replaceAll("_", " "))}` : null,
      `Action: <b>${escapeHtml(order.side.includes("BUY") ? "Buy" : order.side.includes("SELL") ? "Sell" : order.side)}</b>`,
      `Execution: <b>${escapeHtml(orderExecutionLabel(order.orderType, order.timeInForce))}</b>`,
      `Price: <code>${escapeHtml(order.price ?? "market")}</code>`,
      order.averagePrice ? `Average fill: <code>${escapeHtml(order.averagePrice)}</code>` : null,
      "", "<b>◈ FILL PROGRESS</b>",
      `Total: <code>${escapeHtml(total ?? "—")}</code>`,
      `Filled: <code>${escapeHtml(filled)}</code>${total ? ` · <b>${filledPercent(filled, total)}</b>` : ""}`,
      `Remaining: <code>${escapeHtml(remaining ?? "—")}</code>`,
      `Execution rows: <code>${details.executionCount}</code>${details.nextPageToken ? "+" : ""}`,
      "", executionLines.length ? `<b>Recent fills</b>\n${executionLines.join("\n")}` : null,
      "", "<b>REFERENCE</b>",
      `Order ID: <code>${escapeHtml(order.orderId)}</code>`,
      order.clientOrderId ? `Client ID: <code>${escapeHtml(order.clientOrderId)}</code>` : null,
      order.createdAt ? `Created: <code>${escapeHtml(formatTimestamp(order.createdAt))}</code>` : null,
      "",
      "<i>Cumulative quantity is authoritative. Individual execution history can be eventually consistent.</i>"
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
    const preview = await gateway.cancelAll([], true, randomUUID());
    const requestId = randomUUID();
    await editOrReply(ctx, [
      "<b>⚠️ Cancel every open order?</b>",
      "",
      `Polyester dry-run response: <code>${escapeHtml(shorten(JSON.stringify(preview), 900))}</code>`,
      "",
      "A fill can still race with cancellation. This confirmation can be used once."
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
      await ctx.reply("Update submitted. Refresh to confirm final state.", { reply_markup: new InlineKeyboard().text("↻ Refresh", kind === "cancel_order" ? "orders:open" : "triggers:list") });
      return;
    }
    const requestId = targetId;
    database.rememberStatus(`cancel_all:${requestId}`, "sending");
    try {
      const result = await gateway.cancelAll([], false, requestId);
      database.rememberStatus(`cancel_all:${requestId}`, `accepted:${JSON.stringify(result)}`);
      await editOrReply(ctx, `<b>Cancel-all submitted</b>\n<code>${escapeHtml(shorten(JSON.stringify(result), 900))}</code>\n\nRefresh Orders to verify final state.`, new InlineKeyboard().text("↻ Refresh orders", "orders:open").row().text("‹ Overview", "home"));
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
    const lines = visible.map((trigger, index) => `<b>${index + 1}. ${escapeHtml(trigger.type.replaceAll("_", " "))}</b>\n${pairMap.has(trigger.symbolId) ? pairLink(pairMap.get(trigger.symbolId)!) : `#${trigger.symbolId}`}\nStatus: <b>${escapeHtml(trigger.status.replace(/^STATUS_/, ""))}</b>`);
    const keyboard = new InlineKeyboard();
    if (config.tradingMode !== "read_only") keyboard.text("＋ Create strategy", "trigger:new").row();
    visible.forEach((trigger, index) => keyboard.text(`View ${index + 1}`, `td:${trigger.triggerId}`).row());
    if (page > 0) keyboard.text("‹ Previous", `triggers:${mode}:${page - 1}`);
    if ((page + 1) * 6 < filtered.length) keyboard.text("Next ›", `triggers:${mode}:${page + 1}`);
    keyboard.row().text(mode === "list" ? "Strategy history" : "Active strategies", mode === "list" ? "triggers:history" : "triggers:list").row();
    keyboard.text("↻ Refresh strategies", "triggers:list").row().text("‹ Overview", "home");
    await editOrReply(ctx, `${terminalHeading("Strategies")}\n\n${lines.length ? lines.join("\n\n") : "<b>No active strategies</b>\nStop-loss, take-profit, trailing stops, TWAP and ladder strategies appear here."}`, keyboard);
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
    await editOrReply(ctx, [terminalHeading("Strategy status"),
      `Type: ${escapeHtml(trigger.type)}`, `Status: <b>${escapeHtml(trigger.status.replace(/^STATUS_/, ""))}</b>`,
      `Child orders: ${children.length}`, `Filled: ${children.filter(o => o.status.includes("FILLED") && !o.status.includes("PARTIAL")).length}`,
      `Open: ${children.filter(o => isOrderOpen(o.status)).length}`, `Rejected: ${children.filter(o => o.status.includes("REJECT")).length}`,
      ...children.slice(0, 6).map(o => `• ${escapeHtml(o.orderId)}: ${escapeHtml(orderStatusLabel(o.status, o.raw.terminalReason))}`),
      "", "Completed means the strategy finished scheduling orders — not that every order filled.",
      !terminal && !children.length ? "No child orders visible yet. The strategy may be waiting for its condition or API processing; this is not a confirmed fill." : "See Order history for execution details."
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
      await editOrReply(ctx, "Standalone trailing stop currently supports SELL market execution.\nEnter the asset amount:", new InlineKeyboard().text("✕ Discard strategy", "cancel-flow"));
    } else {
      state.step = "tr_side"; saveFlow(ctx, database, state);
      await editOrReply(ctx, "Choose the order direction:", new InlineKeyboard().text("🟢 Buy", "trside:BUY").text("🔴 Sell", "trside:SELL").row().text("✕ Discard strategy", "cancel-flow"));
    }
  });
  bot.callbackQuery(/^trside:(BUY|SELL)$/, async (ctx) => {
    await ctx.answerCallbackQuery(); const state = requireFlow(ctx, database, "trigger");
    state.data.side = ctx.match[1]; state.step = "tr_qty"; saveFlow(ctx, database, state);
    await editOrReply(ctx, "Enter the total asset amount:", new InlineKeyboard().text("✕ Discard strategy", "cancel-flow"));
  });
  bot.callbackQuery(/^trchild:(MARKET_IOC|LIMIT_GTC)$/, async (ctx) => {
    await ctx.answerCallbackQuery(); const state = requireFlow(ctx, database, "trigger");
    state.data.childKind = ctx.match[1];
    if (ctx.match[1] === "LIMIT_GTC") {
      state.step = "tr_child_price"; saveFlow(ctx, database, state);
      await editOrReply(ctx, "<b>Execution price</b>\nWhen the trigger activates, a limit order will stay open at this price until filled or cancelled.\n\nEnter the limit price:", new InlineKeyboard().text("✕ Discard strategy", "cancel-flow"));
    } else {
      state.step = "ready"; saveFlow(ctx, database, state);
      await prepareAndShowTriggerConfirmation(ctx, state);
    }
  });
  bot.callbackQuery("trpreview", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Checking strategy…" });
    await prepareAndShowTriggerConfirmation(ctx, requireFlow(ctx, database, "trigger"));
  });
  bot.callbackQuery(/^confirm:t:([0-9a-f-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Activating strategy…" });
    const ids = requireIds(ctx); const result = await trading.confirmTrigger(ctx.match[1]!, ids.chatId, ids.userId);
    const triggerId = typeof result.triggerId === "string" || typeof result.triggerId === "number" ? String(result.triggerId) : undefined;
    await editOrReply(ctx, [
      "<b>✅ Strategy submitted</b>",
      triggerId ? `Strategy ID: <code>${escapeHtml(triggerId)}</code>` : null,
      "Polyester accepted the strategy. It will now monitor its conditions and execute automatically when they are met.",
      "Open Strategies to verify its current status."
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
          const amount = positiveInput(text);
          delete state.data.maxQuoteDebit;
          delete state.data.sizingPrice;
          if (state.data.sizingMode === "quote") { state.data.quoteAmount = amount; delete state.data.qty; }
          else { state.data.qty = amount; delete state.data.quoteAmount; }
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
    return `${marker} <b>${escapeHtml(pair.symbol.replace("-", "/"))}</b>\n     $${numberText(market?.lastPrice)}   ·   ${escapeHtml(change)}`;
  });

  const updated = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const text = [
    terminalHeading(config.tradingMode === "read_only" ? "Markets" : "Trading"), modeText(config.tradingMode),
    `<i>Live · auto-updates every ${MARKET_REFRESH_MS / 1000}s · ${escapeHtml(updated)}</i>`,
    "",
    `<b>Select a market · ${safePage + 1}/${pages}</b>`,
    ...priceLines,
    "",
    "<i>Open a pair to view its chart, book, and Buy / Sell actions.</i>"
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

async function showPair(ctx: Context, gateway: ExchangeGateway, symbolId: number, timeframe: string): Promise<void> {
  const [catalog, overview, book, candles] = await Promise.all([
    gateway.getCatalog(), gateway.listMarketOverview(), gateway.getOrderbook(symbolId, 5), gateway.getCandles(symbolId, timeframe, 32)
  ]);
  const pair = requirePair(catalog.pairs, symbolId);
  const market = overview.find((item) => item.symbolId === symbolId);
    const closes = [...candles].sort((a, b) => Number(a.tsSec) - Number(b.tsSec)).map((item) => Number(item.close)).filter(Number.isFinite);
  const bid = book.bids[0]?.price ?? market?.bestBid ?? "—";
  const ask = book.asks[0]?.price ?? market?.bestAsk ?? "—";
  const change = market?.change24hBps === null || market?.change24hBps === undefined ? "—" : `${(market.change24hBps / 100).toFixed(2)}%`;
  const keyboard = new InlineKeyboard()
    .text("1m", `pairtf:${symbolId}:1m`).text("5m", `pairtf:${symbolId}:5m`).text("1h", `pairtf:${symbolId}:1h`).text("4h", `pairtf:${symbolId}:4h`).row()
    .text("📚 Order book", `book:${symbolId}:10`).text("↻ Refresh", `pairtf:${symbolId}:${timeframe}`).row()
    .text(`🟢 Buy · ${pair.baseAsset}`, `orderpairside:${symbolId}:BUY`).text(`🔴 Sell · ${pair.baseAsset}`, `orderpairside:${symbolId}:SELL`).row()
    .text("‹ Markets", "markets:0").text("‹ Overview", "home");
  await editOrReply(ctx, [
    heading("Market overview"), pairLink(pair.symbol), "",
    `<b>${pair.quoteAsset === "USDT" ? "$" : ""}${numberText(market?.lastPrice)} ${escapeHtml(pair.quoteAsset)}</b>`,
    `24h: <code>${escapeHtml(change)}</code>`,
    await orderBalances(gateway, pair),
    "", `<b>◈ CHART · ${escapeHtml(timeframe)}</b>`, `<code>${sparkline(closes)}</code>`, "",
    "<b>▥ MARKET DATA</b>",
    `🟢 Bid  ${numberText(bid)}\n🔴 Ask  ${numberText(ask)}`,
    `24h high  ${numberText(market?.high24h)}\n24h low  ${numberText(market?.low24h)}`,
    `24h volume  ${numberText(market?.volume24hBase)} ${escapeHtml(pair.baseAsset)}`, "",
    `<i>Minimum ${numberText(pair.minQtyBase)} ${escapeHtml(pair.baseAsset)} / ${numberText(pair.minNotionalQuote)} ${escapeHtml(pair.quoteAsset)}</i>`
  ].join("\n"), keyboard);
}

async function showOrderbook(ctx: Context, gateway: ExchangeGateway, symbolId: number, depth: number): Promise<void> {
  const [catalog, book] = await Promise.all([gateway.getCatalog(), gateway.getOrderbook(symbolId, depth)]);
  const pair = requirePair(catalog.pairs, symbolId);
  const asks = book.asks.slice(0, depth).reverse().map((level) => `${fitBookValue(level.price)} │ ${fitBookValue(level.qty)}`);
  const bids = book.bids.slice(0, depth).map((level) => `${fitBookValue(level.price)} │ ${fitBookValue(level.qty)}`);
  const body = [
    heading("Order book"), pairLink(pair.symbol),
    `<i>Snapshot sequence ${escapeHtml(book.bookSeq)}</i>`,
    "",
    "<pre>       PRICE │          QTY",
    "─────────────┼─────────────",
    ...asks.map((row) => `ASK ${escapeHtml(row)}`),
    "─────────────┼─────────────",
    ...bids.map((row) => `BID ${escapeHtml(row)}`),
    "</pre>",
    `<i>Asks are shown above bids; closest prices are nearest the divider.</i>`
  ].join("\n");
  await editOrReply(ctx, body, new InlineKeyboard()
    .text("5 levels", `book:${symbolId}:5`).text("10 levels", `book:${symbolId}:10`).text("20 levels", `book:${symbolId}:20`).row()
    .text("↻ Refresh book", `book:${symbolId}:${depth}`).row()
    .text(`🟢 Buy · ${pair.baseAsset}`, `orderpairside:${symbolId}:BUY`).text(`🔴 Sell · ${pair.baseAsset}`, `orderpairside:${symbolId}:SELL`).row()
    .text("‹ Pair overview", `pair:${symbolId}`).text("‹ Markets", "markets:0"));
}

function fitBookValue(value: string): string {
  return (value.length > 13 ? `${value.slice(0, 12)}…` : value).padStart(13);
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
  if (type.includes("MARKET")) return "Market · execute now";
  if (tif.includes("GTC")) return "Limit · stays open until filled or cancelled";
  if (tif.includes("GTD")) return "Limit · active until its expiry time";
  if (tif.includes("FOK")) return "Limit · fill all now or cancel all";
  if (tif.includes("IOC")) return "Limit · fill available now, cancel the rest";
  return [orderType, timeInForce].filter(Boolean).join(" / ") || "Not reported";
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
    const prompt = state.step === "tr_trigger_price" ? "Send trigger price:" : state.step === "tr_trailing_bps" ? "Send trailing distance in bps (1–10000):" : state.step === "tr_duration" ? "Send TWAP duration in seconds:" : "Send ladder minimum price:";
    await ctx.reply(prompt); return false;
  }
  if (state.step === "tr_trigger_price") {
    assertDecimal(text); state.data.triggerPrice = text; state.step = "tr_child"; db.saveWizard(ctx.chat.id, ctx.from.id, state);
    if (state.data.side === "BUY") {
      await ctx.reply("A conditional Buy uses a limit order. It will remain open until filled or cancelled:", { reply_markup: new InlineKeyboard().text("Set limit execution price", "trchild:LIMIT_GTC") });
    } else {
      await ctx.reply("How should the triggered order execute?", { reply_markup: new InlineKeyboard().text("Market · execute immediately", "trchild:MARKET_IOC").row().text("Limit · stays until filled", "trchild:LIMIT_GTC") });
    }
    return false;
  }
  if (state.step === "tr_trailing_bps") {
    state.data.trailingBps = assertInteger(text, 1, 10_000); state.step = "tr_activation"; db.saveWizard(ctx.chat.id, ctx.from.id, state); await ctx.reply("Send activation price, or 0 to activate immediately:"); return false;
  }
  if (state.step === "tr_activation") {
    if (text !== "0") { assertDecimal(text); state.data.activationPrice = text; }
    else delete state.data.activationPrice;
    state.step = "tr_trailing_slippage"; db.saveWizard(ctx.chat.id, ctx.from.id, state); await ctx.reply("Send maximum execution slippage in bps (0–10000; 100 = 1%):"); return false;
  }
  if (state.step === "tr_trailing_slippage") {
    const value = assertInteger(text, 0, 10_000);
    if (value > 0) state.data.maxSlippageBps = value; else delete state.data.maxSlippageBps;
    state.step = "ready"; db.saveWizard(ctx.chat.id, ctx.from.id, state); return true;
  }
  if (state.step === "tr_duration") {
    state.data.durationMs = assertInteger(text, 1, 86_400) * 1000; state.step = "tr_interval"; db.saveWizard(ctx.chat.id, ctx.from.id, state); await ctx.reply("Send slice interval in seconds:"); return false;
  }
  if (state.step === "tr_interval") {
    state.data.sliceIntervalMs = assertInteger(text, 1, 86_400) * 1000; state.step = "tr_child"; db.saveWizard(ctx.chat.id, ctx.from.id, state);
    await ctx.reply("How should each timed slice execute?", { reply_markup: new InlineKeyboard().text("Market · execute now", "trchild:MARKET_IOC").row().text("Limit · stays until filled", "trchild:LIMIT_GTC") }); return false;
  }
  if (state.step === "tr_price_min") { assertDecimal(text); state.data.priceMin = text; state.step = "tr_price_max"; db.saveWizard(ctx.chat.id, ctx.from.id, state); await ctx.reply("Send ladder maximum price:"); return false; }
  if (state.step === "tr_price_max") { assertDecimal(text); state.data.priceMax = text; state.step = "tr_levels"; db.saveWizard(ctx.chat.id, ctx.from.id, state); await ctx.reply("Send number of price levels (2–100):"); return false; }
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
  await editOrReply(ctx, `${heading("Optional settings")}\n\n${formatOrderDraft(draft)}\n\nAdd take-profit, stop-loss or trailing protection if needed.\nChanging settings does not send an order.`, orderOptionsKeyboard(draft));
}

async function editOrReply(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }); }
  catch { await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard }); }
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
