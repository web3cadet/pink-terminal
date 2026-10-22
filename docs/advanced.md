# Pink Terminal — advanced guide

[← Installation and quick start](../README.md)

Technical notes for installation, recovery, trading controls and development.

Pink Terminal is an independent community project, not an official Polyester product. It is a self-hosted Telegram interface for Polyester testnet spot markets. Each operator runs a private instance and keeps the Telegram token and Polyester Ed25519 secret on their own computer or VPS.

The project connects directly to Polyester's documented ConnectRPC JSON interface and does not require the official TypeScript SDK.

## Ubuntu/VPS installer

The guided installer installs the required host packages, downloads the repository, collects credentials, creates an owner-only `.env`, builds the Docker runtime, checks API access and starts the bot. New installations use live testnet mode. Existing installations keep their configured mode.

For a new Ubuntu or Debian VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/web3cadet/pink-terminal/main/install.sh | bash -s -- --repo https://github.com/web3cadet/pink-terminal.git
```

From an existing checkout:

```bash
bash install.sh
```

After installation, use `./manage.sh` to start, stop, restart, update or reconfigure the bot, and to view its status and logs. The installer asks for the API Key ID and matching 32-byte Ed25519 private seed; it does not require the public key.

## Windows and macOS installer

macOS support is Beta. Install Node.js 22.x (22.13 or later), 24.x, or 26+ and Git. Node.js 23 and 25 are not supported.

Open an empty folder in VS Code, open its terminal and run:

```text
npx --yes github:web3cadet/pink-terminal
```

The installer collects the Telegram bot token, allowed numeric Telegram ID, Polyester API Key ID, matching Ed25519 private seed and optional subaccount ID. Secret input is masked. New installations use live testnet mode.

Existing `.env`, local data and runtime state are preserved during an update. The installer synchronizes dependencies, builds the application, checks API access, starts the bot and prints its direct Telegram link.

### Management

Run these commands from the installed bot folder:

```text
npm run manage
npm run bot:start
npm run bot:stop
npm run bot:restart
npm run bot:update
npm run bot:status
npm run bot:logs
npm run bot:configure
npm run bot:uninstall
```

`npm run bot:update` installs the current GitHub `main` version while preserving `.env` and local data. Application files are replaced, so back up custom code first. Source Git checkouts are not overwritten and should be updated with Git.

Local operation requires an awake, online computer. Start the bot again after logout or reboot; the manager does not register a login service.

### Recovery after accidental file deletion

Stop or uninstall the bot before deleting its files. If the local management scripts are missing, open the affected installation folder in the VS Code terminal and run only the command you need:

```text
npx --yes github:web3cadet/pink-terminal --status
npx --yes github:web3cadet/pink-terminal --stop
npx --yes github:web3cadet/pink-terminal --uninstall
```

Uninstall backs up `.env`, then removes the installation, local history and logs. It does not cancel orders or strategies already submitted to Polyester. Keep `.runtime` until the bot has stopped because it contains the process-control state.

### Configuration changes

Use `npm run bot:configure` to replace credentials or change the optional subaccount. Changing credentials, endpoint, subaccount or trading mode invalidates pending confirmations and old control buttons. Refresh Orders or Strategies after a configuration change.

If the API access check fails, correct the permissions or replace the API Key ID and private seed, then run the check again. The access check uses `PreviewOrder` and does not place an order.

## Features and trading behavior

- live market discovery from `GetSpotConfig`, with no hard-coded pair list
- portfolio, Trading and Funding balances, available and reserved amounts, and bot trading volume
- market cards, 24-hour statistics, candle sparklines and 5/10/20-level order books
- market IOC and limit GTC/GTD/IOC/FOK orders, including post-only GTC
- quote-value, base-quantity and percentage amount input
- attached take-profit, stop-loss, trailing stop and OCO controls
- standalone take-profit, stop-loss, trailing-stop, TWAP and linear ladder strategies
- open orders, order history, fill information, cancellation and strategy controls
- `PreviewOrder` before every live order
- allowlisted Telegram users and short-lived confirmations
- paper and read-only modes, SQLite history, secret-filtering logs and Docker deployment
- persisted client order IDs and reconciliation of uncertain submissions

Batch market making, transfers, withdrawals, wallet login and API-key administration are outside the scope of Pink Terminal.

### Order sizing

**Configuration → Amount input** selects quote value or base-token quantity for regular orders. Quote value is the default. Buys use the pair's quote asset and sells use its base asset.

All regular order types accept percentages such as `10%` or `2.5%`. A percentage buy uses that share of the available quote balance, including the fee budget. A percentage sell uses that share of the available base-token balance. Reserved funds are excluded. The calculated budget or quantity is fixed when entered and is not recalculated on confirmation.

Quantities are rounded down to the pair's step. Polyester balances, market rules, liquidity and `PreviewOrder` remain authoritative.

### Confirmations and navigation

Regular orders require final confirmation by default. The final card offers **Confirm**, **Discard order** and **Disable future confirmations**. Disabling confirmation affects future regular orders only; strategies continue to require confirmation. The preference is stored per Telegram user, chat and API configuration.

Buttons act on the card where they were created. Superseded order cards have their buttons removed. `/menu` and `/start` open a fresh terminal message. The market screen refreshes automatically by editing the existing message instead of posting repeated updates.

Stopping, uninstalling or reconfiguring Pink Terminal does not cancel orders or strategies already submitted to Polyester.

## Configuration reference

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Private bot token |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated controlling chat IDs |
| `TELEGRAM_ALLOWED_USER_IDS` | Optional comma-separated controlling user IDs |
| `POLYESTER_API_URL` | Defaults to the official testnet API |
| `POLYESTER_API_KEY_ID` | Public Polyester API key identifier |
| `POLYESTER_API_SECRET_HEX` | 32-byte Ed25519 private seed in hexadecimal |
| `POLYESTER_SUBACCOUNT_ID` | Optional subaccount ID |
| `TRADING_MODE` | `paper` simulates orders, `read_only` blocks mutations, and `live` enables signed testnet operations |
| `POLL_INTERVAL_MS` | Background maintenance and reconciliation interval; minimum 10 seconds |

There are no additional local order-size caps. Polyester account policy, balances, market metadata and server preview determine whether an order can be accepted.

See [SECURITY.md](../SECURITY.md) before changing security-sensitive settings.

## Architecture

```text
Telegram user
      │ allowlist + confirmation
      ▼
Telegram bot ──► order validation ──► local intent journal
                                             │
                                             ▼
                               Polyester ConnectRPC JSON API
                               Ed25519-signed private requests
```

Public market data requires no API key. Private reads and mutations are signed with the configured Ed25519 key. Client order IDs are stored before submission so an uncertain response can be reconciled without blindly creating another order.

The market screen uses bounded polling and edits one Telegram message. It is not a tick-by-tick WebSocket feed. `POLL_INTERVAL_MS` controls background maintenance and order reconciliation, not the market-screen refresh. Order fill status uses `cumQty` and `leavesQty`; recent execution rows are supplemental and can arrive later.

## Local development

Use a VS Code terminal with Node.js 22.13+, 24.x or 26+:

```bash
npm ci
npm run check
npm run smoke:public
cp .env.example .env
npm run dev
```

Keep real credentials in the local `.env` file and out of commits, issues and chat messages.

## Upstream documentation

- [Developer documentation](https://testnet.polyester.com/docs/developer-docs/getting-started)
- [ConnectRPC getting started](https://testnet.polyester.com/docs/developer-docs/connectrpc/getting-started)
- [Ed25519 API keys](https://testnet.polyester.com/docs/developer-docs/authentication-security)
- [Client order IDs and idempotency](https://testnet.polyester.com/docs/developer-docs/shared-concepts/client-order-ids)
- [Preview order](https://testnet.polyester.com/docs/developer-docs/shared-concepts/preview-order)
- [Market order price protection](https://testnet.polyester.com/docs/developer-docs/shared-concepts/market-order-price-protection)
- [Orders reference](https://testnet.polyester.com/docs/sdk/typescript/reference/orders)
- [Triggers reference](https://testnet.polyester.com/docs/sdk/typescript/reference/triggers)
