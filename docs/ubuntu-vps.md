# Ubuntu VPS deployment

The commands below are Bash commands for an Ubuntu VPS. Docker Compose is the recommended deployment because it pins Node.js and isolates runtime dependencies.

## Guided installation

The interactive installer performs the dependency, configuration, credential-readiness, build, and startup stages below:

```bash
bash install.sh
```

Once the repository is public, use the one-line command from the project README. The wizard stores its `.env` with owner-only permissions, never prints secret inputs, and requires explicit selection of live, read-only, or paper mode. Use `./manage.sh` afterward for lifecycle management.

## 1. Prepare the server

```bash
sudo apt update
sudo apt install -y ca-certificates git docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Log out and back in once after adding the Docker group.

Keep the server clock synchronized. Polyester rejects API-key timestamps outside its short freshness window:

```bash
timedatectl status
sudo timedatectl set-ntp true
```

## 2. Copy the project

Clone the repository or upload the `Polyester Bot` folder, then enter it:

```bash
cd "Polyester Bot"
cp .env.example .env
chmod 600 .env
nano .env
```

Required values:

- `TELEGRAM_BOT_TOKEN`: token created through BotFather.
- `TELEGRAM_ALLOWED_CHAT_IDS`: the private chat ID allowed to control the bot.
- `TELEGRAM_ALLOWED_USER_IDS`: the Telegram user ID allowed to press trading buttons.
- `POLYESTER_API_KEY_ID`: the public `ak_...` key identifier.
- `POLYESTER_API_SECRET_HEX`: the 32-byte Ed25519 private seed in hex. Keep it only on this server.

Start with `TRADING_MODE=paper`. The bot can display public market data immediately; private balances need the read permissions described below.

## 3. Create a restricted Polyester key

In Polyester testnet, create a dedicated API key and policy with:

- `read-balances`
- `read-spot`
- `trade-spot`

Do not grant withdrawals or transfers. Restrict it to the required markets, add an expiry, and add the VPS public address as a `/32` IP allowlist when possible.

## 4. Build and start

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 bot
```

The container makes outbound connections only; no inbound application port is required.

## 5. Acceptance sequence

Do not switch directly from installation to unrestricted writes.

1. Keep `TRADING_MODE=paper`.
2. Open `/start`, inspect every market page, balances, order wizard, and all five trigger wizards.
3. Verify that malformed quantities and prices are rejected and that Polyester preview handles account and market constraints.
4. Confirm that a Telegram account outside both allowlists cannot use the bot.
5. Change `TRADING_MODE=live`, rebuild, and submit one deliberately small testnet order.
6. Verify the final order state under Orders; an admission acknowledgement is not a fill.
7. Test strategies only after normal order placement and cancellation are confirmed.

After changing `.env`:

```bash
docker compose up -d --build
docker compose logs --tail=100 bot
```

## 6. Backup and update

The SQLite journal is stored under `./data`. Stop the container before a simple file backup:

```bash
docker compose stop bot
tar -czf "polyester-bot-data-$(date +%F).tar.gz" data
docker compose start bot
```

Update only after reading changes and rerunning checks:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs --tail=100 bot
```

## Troubleshooting

- `TIMESTAMP_SKEW`: fix NTP/time synchronization.
- `SIGNATURE_INVALID`: verify the key ID and 32-byte secret belong to the same key; do not retry writes blindly.
- `PermissionError`: attach a policy with the required read/trade actions and market scope.
- `IP_NOT_ALLOWED`: update the key allowlist to the VPS egress IP.
- Empty trading balance: Polyester spot orders spend Trading balance, not Funding balance.
