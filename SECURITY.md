# Security policy

This bot signs trading requests and must be treated as a security-sensitive application.

## Credential rules

- Never send a Telegram bot token, Polyester key ID, or Ed25519 secret through Telegram, Discord, an issue, a commit, or a screenshot.
- Put secrets only in the server-side `.env` file. The repository ignores that file.
- The Windows installer restricts `.env` to the installing Windows account, SYSTEM and administrators. That account can still open, edit and delete it normally, without an extra password. This does not protect against malware running as that user or an administrator. On macOS and Ubuntu, use owner-only file permissions.
- Create a dedicated Polyester testnet API key. Grant only `read-balances`, `read-spot`, and `trade-spot`.
- Do not grant withdrawal, internal-transfer, address-book, or account-administration permissions.
- Prefer a subaccount, a market allowlist, an expiry, and a `/32` IP allowlist for the VPS.
- Restrict both `TELEGRAM_ALLOWED_CHAT_IDS` and `TELEGRAM_ALLOWED_USER_IDS`.
- Revoke and replace a key immediately if the `.env` file, VPS, logs, or terminal history may have exposed it.

## Safe defaults

- `TRADING_MODE=paper` prevents exchange mutations.
- Every order or trigger requires a short-lived, one-time Telegram confirmation.
- Pending confirmations are bound to the API endpoint, credentials, subaccount and trading mode. Changing these invalidates pending confirmations, including legacy unbound confirmations; submitted exchange orders and strategies are not cancelled.
- Windows installation and management operations are exclusive per installation folder. This does not coordinate separate copies using the same Telegram token.
- The bot does not impose artificial order-size or execution caps; Polyester balances, market rules, API policy, and server preview are authoritative.
- Client order IDs are persisted before submission. Unknown outcomes are reconciled; they are never blindly resubmitted.
- Cancel-all and strategy writes require writable mode and retain explicit confirmation flows.
- Logs deliberately drop fields whose names look like tokens, secrets, signatures, authorization headers, or cookies.

## Production hardening

Use a private VPS account, automatic security updates, SSH keys, a firewall, NTP, encrypted backups, and a secret manager where practical. Make `.env` readable only by the service user. Do not expose an inbound web port: the bot uses Telegram long polling.

This repository is testnet software. Do not point it at mainnet until Polyester confirms the contracts and a separate security review has been completed.
