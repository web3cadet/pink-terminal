# Ubuntu VPS deployment

The commands below are Bash commands for an Ubuntu VPS. Docker Compose is the recommended deployment because it pins Node.js and isolates runtime dependencies.

## Guided installation

Run the one-line installer from the project README:

```bash
curl -fsSL https://raw.githubusercontent.com/web3cadet/pink-terminal/main/install.sh | bash -s -- --repo https://github.com/web3cadet/pink-terminal.git
```

The wizard installs the required components, stores `.env` with owner-only permissions, never prints secret inputs, and lets you select live, read-only, or paper mode. Use `./manage.sh` afterward for lifecycle management.

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

Clone the repository or upload the `Pink Terminal` folder, then enter it:

```bash
cd "Pink Terminal"
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

Set `TRADING_MODE` to the mode you want: `paper` for simulated orders, `read_only` for account data without mutations, or `live` for testnet orders and strategies.

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

## 5. Backup and update

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
