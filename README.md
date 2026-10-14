# Pink Terminal

Copyright © 2026 099andr. Licensed under the
[Apache License 2.0](LICENSE).

This is an independent community project. It is not developed or operated by
the official Polyester team. Polyester and the Polyester logo belong to their
respective rights holders.

An independent, self-hosted Telegram interface for Polyester testnet spot markets. Each operator runs a private instance and keeps the Telegram token and Polyester Ed25519 secret on their own VPS.

The project talks directly to Polyester's documented ConnectRPC JSON interface. It does not copy, bundle, or depend on the official TypeScript SDK. Pink Terminal does not set or replace the Telegram bot's profile photo automatically.

## Guided Ubuntu/VPS installer

`install.sh` provides a terminal setup wizard that installs the host prerequisites, obtains the repository, validates the Telegram token, stores secrets in a local mode-`600` `.env`, builds the isolated Docker runtime, checks authenticated Polyester reads and a non-mutating live order preview, and waits for the Telegram bot to reach its started state.

When working from an existing local checkout, run the wizard from the project directory:

```bash
bash install.sh
```

For a new Ubuntu or Debian VPS, use the public one-line installer:

```bash
curl -fsSL https://raw.githubusercontent.com/web3cadet/pink-terminal/main/install.sh | bash -s -- --repo https://github.com/web3cadet/pink-terminal.git
```

The installer reads interactive answers directly from the terminal, so the wizard continues to work when the script is piped from `curl`. After installation, open the numeric management menu with `./manage.sh` to start, stop, restart, inspect status or logs, reconfigure, or update the bot. The installer never asks for a Polyester public key: the API Key ID and 32-byte private Ed25519 seed are sufficient.

## Guided Windows installer

The Windows release uses a single cross-shell command in the integrated VS Code terminal. The user opens an empty folder and runs:

```text
npx --yes github:web3cadet/pink-terminal
```

The package exposes `scripts/windows-installer.mjs` as its only executable, so `npx` downloads the current repository and immediately opens the guided installer. It preserves an existing `.env`, `data/`, `.runtime/` and installed dependencies during a source refresh, then synchronizes dependencies, runs the complete check suite, builds production output, validates authenticated reads and a non-mutating live preview, starts the Telegram bot in the background and prints its direct `t.me` URL.

The wizard requests only the Telegram bot token, allowed numeric chat/user ID, Polyester API Key ID, matching 32-byte Ed25519 private seed, and optional subaccount ID. Secret fields are masked. It always configures the current release in LIVE testnet mode; transfer and withdrawal permissions are neither requested nor used.

After installation, management does not require re-running setup:

```text
npm run manage
npm run bot:start
npm run bot:stop
npm run bot:restart
npm run bot:status
npm run bot:logs
```

Re-run the original one-line installer only to refresh source code and dependencies or to reopen the configuration flow. Ordinary restarts should use `npm run bot:restart`. Windows sleep or shutdown still stops local availability; use the Ubuntu/VPS path for a continuously available bot.

## What is implemented

- live discovery and a single-message terminal for every enabled pair from `GetSpotConfig`; no hard-coded market list
- 10-second-or-slower in-place price polling, current balances, and open-order summary without Telegram message spam
- market cards, 24-hour statistics, selectable 1m/5m/1h/4h candle sparklines, and 5/10/20-level order books
- private Trading/Funding/available/reserved balances
- market IOC and limit GTC/GTD/IOC/FOK order wizards
- base-quantity sizing and quote-budget sizing where the Polyester contract supports it
- post-only GTC orders, fee-asset rules, per-order slippage tolerance, client reference price support in the API layer
- attached take-profit, stop-loss, trailing stop, and OCO composition
- standalone stop-loss, take-profit, trailing-stop, TWAP, and linear ladder triggers
- clickable open/history orders with total, authoritative cumulative fill, remaining quantity, fill percentage, average price, and recent per-fill execution rows
- confirmed single-order cancellation, dry-run + confirmation for cancel-all, trigger pause/resume/confirmed cancel
- server `PreviewOrder` before every live order
- one-time confirmations, expiry, exchange-aware precision/minimum validation, allowlisted Telegram chat/user IDs
- stable client IDs persisted before submission and reconciliation of ambiguous order outcomes
- paper mode, SQLite journal, structured secret-filtering logs, Docker deployment

Batch market-making workflows, transfer/withdrawal operations, wallet login, and API-key administration are intentionally outside this Telegram terminal. Money movement requires a separate authority and should not share a trading bot key.

## Verified and not yet verified

Verified in this repository:

- TypeScript strict compilation
- unit tests for request signing, documented query canonicalization, exact decimal scaling, public-ID conversion, local risk rules, and single-use confirmation state
- public testnet calls for catalog, market overview, order book, trades, and candles
- dependency audit with zero known vulnerabilities at the recorded lock-file state

Not yet verified:

- authenticated testnet balance reads
- authenticated preview/create/cancel and trigger mutations
- complete Telegram end-to-end interaction with a real bot token

Those checks require the operator's credentials and must be performed with the staged acceptance sequence in [docs/ubuntu-vps.md](docs/ubuntu-vps.md). Passing unit tests does not prove live exchange acceptance.

## Local development

Use a VS Code terminal with Node.js 22 or newer:

```bash
cd "Pink Terminal"
npm ci
npm run check
npm run smoke:public
cp .env.example .env
npm run dev
```

Never paste real secrets into chat. Edit `.env` locally and keep it out of Git.

## Configuration

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Private bot token |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated controlling chat IDs |
| `TELEGRAM_ALLOWED_USER_IDS` | Optional comma-separated controlling user IDs |
| `POLYESTER_API_URL` | Defaults to the official testnet API |
| `POLYESTER_API_KEY_ID` | Public Polyester API key identifier |
| `POLYESTER_API_SECRET_HEX` | 32-byte Ed25519 secret seed in hex |
| `POLYESTER_SUBACCOUNT_ID` | Optional numeric subaccount scope |
| `TRADING_MODE` | `paper` uses simulated funds; `read_only` reads the real account and blocks every mutation; `live` enables signed mutations |
There are no artificial local notional or execution caps. In `live` mode all implemented trading, cancellation, and strategy operations are available after their confirmation step; Polyester account policy, balances, market metadata, and server preview remain authoritative.

See [SECURITY.md](SECURITY.md) before enabling live writes.

## Architecture

```text
Telegram user
      │ allowlist + one-time confirmation
      ▼
Telegram bot ──► deterministic risk guard ──► durable intent journal
                                                    │
                                                    ▼
                                      Polyester ConnectRPC JSON API
                                      Ed25519 signed private requests
```

Public market data requires no API key. Private reads and mutations use the exact serialized request body in the Polyester canonical signature. An uncertain mutation is recorded as unknown and reconciled by its previously persisted client ID; it is not sent again with a new ID.

The live Telegram terminal uses bounded polling and edits one existing message. It is not a tick-by-tick WebSocket feed. `POLL_INTERVAL_MS` cannot be set below 10 seconds, which limits API and Telegram edit pressure. Order `cumQty`/`leavesQty` are used for fill status; individual execution-history rows can lag and are displayed as supplemental data only.

## Upstream documentation

- [Developer documentation](https://testnet.polyester.com/docs/developer-docs/getting-started)
- [ConnectRPC getting started](https://testnet.polyester.com/docs/developer-docs/connectrpc/getting-started)
- [Ed25519 API keys](https://testnet.polyester.com/docs/developer-docs/authentication-security)
- [Client order IDs and idempotency](https://testnet.polyester.com/docs/developer-docs/shared-concepts/client-order-ids)
- [Preview order](https://testnet.polyester.com/docs/developer-docs/shared-concepts/preview-order)
- [Market order price protection](https://testnet.polyester.com/docs/developer-docs/shared-concepts/market-order-price-protection)
- [Orders reference](https://testnet.polyester.com/docs/sdk/typescript/reference/orders)
- [Triggers reference](https://testnet.polyester.com/docs/sdk/typescript/reference/triggers)

Polyester names and marks belong to their respective owner. This community project is not presented as an official client.
