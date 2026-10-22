# Pink Terminal

Self-hosted Telegram trading terminal for Polyester testnet. Runs on Windows, Ubuntu VPS and macOS (Beta).

An independent community project, not an official Polyester product.

## Features

- Portfolio, balances and bot trading volume.
- Market prices, candle charts and order books.
- Market and limit orders, with amount, quantity or percentage input.
- Take-profit, stop-loss, trailing stop, TWAP and ladder strategies.
- Open orders, execution history, cancellation and strategy controls.
- Restricted Telegram access and order confirmations enabled by default.

## Before you install

1. Your Telegram bot token and numeric Telegram user/chat ID.
2. A dedicated Polyester **testnet** API Key ID and matching private Ed25519 seed (64 hexadecimal characters).
3. API permissions for **balances read, spot trading read and spot trading write**. Do not enable transfers or withdrawals. A subaccount ID is optional.

Enter credentials in the installer, not in Telegram. They are stored locally in `.env`; never share this file.

## Installation

### Windows / macOS (Beta)

Install **Node.js 22.x (22.13 or later), 24.x, or 26+**, including npm, and **Git**. Node 23 and 25 are not supported.

Open an **empty folder in VS Code**, open its terminal and run:

```text
npx --yes github:web3cadet/pink-terminal
```

Follow the setup wizard. Keep your computer awake and online while using the bot; start it again after logout or reboot.

### Ubuntu VPS

Connect to your VPS and run:

```bash
curl -fsSL https://raw.githubusercontent.com/web3cadet/pink-terminal/main/install.sh | bash -s -- --repo https://github.com/web3cadet/pink-terminal.git
```

The wizard installs prerequisites, checks API access and starts the bot in Docker.

### Open your terminal in Telegram

Open the bot link shown after installation and send `/start`. Use the buttons to trade, view balances and manage orders. Send `/menu` to open a fresh terminal message.

The guided installer configures **live testnet trading**. Its access check uses a non-mutating preview and does not place an order.

## Manage your bot

Run management commands **from the installed bot folder**.

**Windows / macOS:**

```text
npm run manage
```

**Ubuntu VPS:**

```bash
./manage.sh
```

The menu includes start, stop, restart, status, logs, credentials, updates and uninstall.

Updates preserve credentials and local data, but replace application code. Uninstall backs up `.env` and deletes the installation, local history and logs. Use the menu instead of deleting files manually.

## Important to know

- Regular orders require confirmation by default. Disabling **Configuration → Order confirmation** allows submission immediately after entering the required details. Strategies still require confirmation.
- Stopping, uninstalling or reconfiguring the bot does **not** cancel orders or strategies already submitted to Polyester.
- Use a separate installation for a separate account if you need separate local history and statistics.
- This release is for Polyester testnet only. macOS remains Beta.

## More information

- [Advanced guide](docs/advanced.md) — recovery, order sizing, configuration and development.
- [Ubuntu/VPS guide](docs/ubuntu-vps.md) · [Security](SECURITY.md)
- [Report a bug](https://github.com/web3cadet/pink-terminal/issues) — remove tokens, keys and personal data from logs/screenshots first.

Copyright © 2026 099andr · [Apache License 2.0](LICENSE).
