#!/usr/bin/env bash
set -Eeuo pipefail

# Polyester Trading Terminal installer for Ubuntu/Debian hosts.
# Canonical public source used when the installer is launched without --repo.

DEFAULT_REPOSITORY_URL="https://github.com/web3cadet/polyester-community-trading-bot.git"
REPOSITORY_URL="${POLYESTER_BOT_REPO_URL:-$DEFAULT_REPOSITORY_URL}"
INSTALL_DIR="${POLYESTER_BOT_DIR:-$HOME/polyester-trading-terminal}"
FORCE_RECONFIGURE=false

PINK='\033[38;2;250;47;111m'
GREEN='\033[38;2;70;211;105m'
CYAN='\033[38;2;72;199;235m'
YELLOW='\033[38;2;255;196;61m'
RED='\033[38;2;255;92;92m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

if [[ -r /dev/tty && -w /dev/tty ]]; then
  exec 3</dev/tty 4>/dev/tty
else
  exec 3<&0 4>&1
fi

umask 077
BUILD_LOG=""
cleanup() {
  unset TELEGRAM_TOKEN TELEGRAM_USER_ID API_KEY_ID API_SECRET_HEX SUBACCOUNT_ID
  if [[ -n "$BUILD_LOG" && -f "$BUILD_LOG" ]]; then
    rm -f -- "$BUILD_LOG"
  fi
}
trap cleanup EXIT

say() { printf '%b\n' "$*" >&4; }
die() { say "${RED}${BOLD}Error:${RESET} $*"; exit 1; }

banner() {
  printf '\033[2J\033[H' >&4
  say "${PINK}${BOLD}"
  say '  ██████╗  ██████╗ ██╗  ██╗   ██╗███████╗███████╗████████╗███████╗██████╗ '
  say '  ██╔══██╗██╔═══██╗██║  ╚██╗ ██╔╝██╔════╝██╔════╝╚══██╔══╝██╔════╝██╔══██╗'
  say '  ██████╔╝██║   ██║██║   ╚████╔╝ █████╗  ███████╗   ██║   █████╗  ██████╔╝'
  say '  ██╔═══╝ ██║   ██║██║    ╚██╔╝  ██╔══╝  ╚════██║   ██║   ██╔══╝  ██╔══██╗'
  say '  ██║     ╚██████╔╝███████╗ ██║   ███████╗███████║   ██║   ███████╗██║  ██║'
  say '  ╚═╝      ╚═════╝ ╚══════╝ ╚═╝   ╚══════╝╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝'
  say "${RESET}"
  say "${BOLD}                         TRADING TERMINAL${RESET}"
  say "${DIM}                  self-hosted · testnet · private${RESET}"
  say ""
}

progress() {
  local percent="$1" label="$2" width=30 filled empty bar empty_bar
  filled=$((percent * width / 100))
  empty=$((width - filled))
  printf -v bar '%*s' "$filled" ''
  bar=${bar// /█}
  printf -v empty_bar '%*s' "$empty" ''
  say "${GREEN}[${bar}${DIM}${empty_bar}${RESET}${GREEN}] ${percent}%%${RESET}  ${label}"
}

read_value() {
  local prompt="$1" target="$2" default_value="${3:-}" value
  if [[ -n "$default_value" ]]; then
    printf '%b' "${BOLD}${prompt}${RESET} ${DIM}[${default_value}]${RESET}: " >&4
  else
    printf '%b' "${BOLD}${prompt}${RESET}: " >&4
  fi
  IFS= read -r value <&3
  [[ -n "$value" ]] || value="$default_value"
  printf -v "$target" '%s' "$value"
}

read_secret() {
  local prompt="$1" target="$2" value
  printf '%b' "${BOLD}${prompt}${RESET}: " >&4
  IFS= read -r -s value <&3
  say ""
  printf -v "$target" '%s' "$value"
}

choose() {
  local prompt="$1" target="$2" min="$3" max="$4" value
  while true; do
    printf '%b' "${BOLD}${prompt}${RESET}: " >&4
    IFS= read -r value <&3
    if [[ "$value" =~ ^[0-9]+$ ]] && (( value >= min && value <= max )); then
      printf -v "$target" '%s' "$value"
      return
    fi
    say "${YELLOW}Choose a number from ${min} to ${max}.${RESET}"
  done
}

show_disclaimer() {
  say "${YELLOW}${BOLD}Before you continue${RESET}"
  say ""
  say "This community-built client is provided for education and Polyester testnet testing."
  say "In LIVE mode it can create and cancel signed testnet orders using your API key."
  say "It is not financial advice, has no warranty, and is not presented as an official"
  say "Polyester client. Use a dedicated restricted API key with no transfer or withdrawal"
  say "permissions. You remain responsible for the server, credentials, and every action."
  say ""
  say "  ${GREEN}1)${RESET} I have read this and want to continue"
  say "  ${RED}2)${RESET} Exit"
  local answer
  choose "Selection" answer 1 2
  [[ "$answer" == "1" ]] || exit 0
}

as_root() {
  if [[ "$EUID" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

ensure_host_tools() {
  if command -v git >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 \
    && command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi

  [[ "$(uname -s)" == "Linux" ]] || die "Automatic installation supports Ubuntu/Debian Linux."
  command -v apt-get >/dev/null 2>&1 || die "apt-get is required for automatic dependency installation."
  if [[ "$EUID" -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || die "sudo is required to install Docker and Git."
    sudo -v || die "sudo authorization failed."
  fi

  say "${CYAN}Installing required host packages…${RESET}"
  as_root apt-get update -y
  as_root apt-get install -y ca-certificates curl git docker.io
  if ! as_root apt-get install -y docker-compose-v2; then
    as_root apt-get install -y docker-compose-plugin
  fi
  as_root systemctl enable --now docker
}

parse_arguments() {
  while (($#)); do
    case "$1" in
      --repo)
        (($# >= 2)) || die "--repo requires a Git URL."
        REPOSITORY_URL="$2"
        shift 2
        ;;
      --dir)
        (($# >= 2)) || die "--dir requires a destination path."
        INSTALL_DIR="$2"
        shift 2
        ;;
      --reconfigure)
        FORCE_RECONFIGURE=true
        shift
        ;;
      --help|-h)
        say "Usage: bash install.sh [--repo URL] [--dir PATH] [--reconfigure]"
        exit 0
        ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

resolve_application() {
  local source_path source_dir
  source_path="${BASH_SOURCE[0]}"
  source_dir=""
  if [[ "$source_path" != /dev/fd/* && "$source_path" != /proc/self/fd/* ]]; then
    source_dir="$(cd -- "$(dirname -- "$source_path")" && pwd)"
  fi

  if [[ -n "$source_dir" && -f "$source_dir/package.json" && -f "$source_dir/docker-compose.yml" ]]; then
    APP_DIR="$source_dir"
    return
  fi

  [[ -n "$REPOSITORY_URL" ]] || die "Repository URL is not configured. Pass --repo https://github.com/web3cadet/polyester-community-trading-bot.git"
  [[ "$REPOSITORY_URL" =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$ ]] \
    || die "--repo must be a public GitHub HTTPS repository URL."

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    say "${CYAN}Updating the existing checkout…${RESET}"
    git -C "$INSTALL_DIR" pull --ff-only
  elif [[ -e "$INSTALL_DIR" ]]; then
    die "Destination already exists and is not a Git checkout: $INSTALL_DIR"
  else
    git clone --depth 1 "$REPOSITORY_URL" "$INSTALL_DIR"
  fi
  APP_DIR="$INSTALL_DIR"
}

validate_telegram_token() {
  local response
  response="$(
    printf 'silent\nshow-error\nfail\nmax-time = 12\nurl = "https://api.telegram.org/bot%s/getMe"\n' "$TELEGRAM_TOKEN" \
      | curl --config - 2>/dev/null
  )" || return 1
  [[ "$response" =~ \"ok\"[[:space:]]*:[[:space:]]*true ]]
}

collect_configuration() {
  say "${PINK}${BOLD}Telegram access${RESET}"
  while true; do
    read_secret "Telegram bot token from @BotFather" TELEGRAM_TOKEN
    [[ "$TELEGRAM_TOKEN" =~ ^[0-9]{6,12}:[A-Za-z0-9_-]{25,}$ ]] || {
      say "${YELLOW}That does not look like a Telegram bot token. Try again.${RESET}"
      continue
    }
    say "${DIM}Checking the token with Telegram…${RESET}"
    validate_telegram_token && break
    say "${YELLOW}Telegram rejected the token or could not be reached. Try again.${RESET}"
  done

  while true; do
    read_value "Your numeric Telegram user ID (private chat ID)" TELEGRAM_USER_ID
    [[ "$TELEGRAM_USER_ID" =~ ^[1-9][0-9]{4,19}$ ]] && break
    say "${YELLOW}Enter a positive numeric Telegram user ID.${RESET}"
  done

  say ""
  say "${PINK}${BOLD}Polyester API credentials${RESET}"
  while true; do
    read_value "API Key ID (ak_…)" API_KEY_ID
    [[ "$API_KEY_ID" =~ ^ak_[A-Za-z0-9]{16,}$ ]] && break
    say "${YELLOW}The API Key ID must begin with ak_.${RESET}"
  done
  while true; do
    read_secret "Private Ed25519 seed (64 hexadecimal characters)" API_SECRET_HEX
    API_SECRET_HEX="${API_SECRET_HEX#0x}"
    API_SECRET_HEX="${API_SECRET_HEX#0X}"
    [[ "$API_SECRET_HEX" =~ ^[A-Fa-f0-9]{64}$ ]] && break
    say "${YELLOW}Expected exactly 64 hexadecimal characters.${RESET}"
  done
  while true; do
    read_value "Subaccount ID; press Enter for the primary account" SUBACCOUNT_ID ""
    [[ -z "$SUBACCOUNT_ID" || "$SUBACCOUNT_ID" =~ ^[0-9]+$ ]] && break
    say "${YELLOW}Subaccount ID must be numeric or empty.${RESET}"
  done

  say ""
  say "${PINK}${BOLD}Trading mode${RESET}"
  say "  ${GREEN}1)${RESET} LIVE testnet — signed orders and strategies"
  say "  ${CYAN}2)${RESET} Read-only — account data, no writes"
  say "  ${CYAN}3)${RESET} Paper — simulated orders"
  local mode_choice
  choose "Selection" mode_choice 1 3
  case "$mode_choice" in
    1) TRADING_MODE=live ;;
    2) TRADING_MODE=read_only ;;
    3) TRADING_MODE=paper ;;
  esac

  say ""
  say "${BOLD}Configuration summary${RESET}"
  say "  Telegram user:  ${CYAN}${TELEGRAM_USER_ID}${RESET}"
  say "  Polyester key:  ${CYAN}${API_KEY_ID}${RESET}"
  say "  Trading mode:    ${CYAN}${TRADING_MODE}${RESET}"
  say "  Local limits:    ${GREEN}none; Polyester rules apply${RESET}"
  say "  Secrets:         ${GREEN}hidden; stored only in local .env${RESET}"
  say ""
  say "  ${GREEN}1)${RESET} Save and deploy"
  say "  ${YELLOW}2)${RESET} Enter again"
  say "  ${RED}3)${RESET} Exit"
  local confirmation
  choose "Selection" confirmation 1 3
  case "$confirmation" in
    1) return ;;
    2) collect_configuration; return ;;
    3) exit 0 ;;
  esac
}

write_environment() {
  local target="$APP_DIR/.env" temporary
  temporary="$(mktemp "$APP_DIR/.env.tmp.XXXXXX")"
  chmod 600 "$temporary"
  {
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_TOKEN"
    printf 'TELEGRAM_ALLOWED_CHAT_IDS=%s\n' "$TELEGRAM_USER_ID"
    printf 'TELEGRAM_ALLOWED_USER_IDS=%s\n' "$TELEGRAM_USER_ID"
    printf '\nPOLYESTER_API_URL=https://api.testnet.polyester.com\n'
    printf 'POLYESTER_API_KEY_ID=%s\n' "$API_KEY_ID"
    printf 'POLYESTER_API_SECRET_HEX=%s\n' "$API_SECRET_HEX"
    printf 'POLYESTER_SUBACCOUNT_ID=%s\n' "$SUBACCOUNT_ID"
    printf '\nTRADING_MODE=%s\n' "$TRADING_MODE"
    printf 'CONFIRMATION_TTL_SECONDS=90\n'
    printf '\nDATABASE_PATH=./data/polyester-bot.sqlite\n'
    printf 'POLL_INTERVAL_MS=15000\n'
    printf 'LOG_LEVEL=info\n'
  } >"$temporary"
  mv -f -- "$temporary" "$target"
  chmod 600 "$target"
}

select_docker() {
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif [[ "$EUID" -ne 0 ]] && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    die "Docker is installed but the daemon is unavailable."
  fi
}

compose() {
  "${DOCKER[@]}" compose --project-directory "$APP_DIR" -f "$APP_DIR/docker-compose.yml" "$@"
}

deploy() {
  mkdir -p "$APP_DIR/data"
  as_root chown -R 1000:1000 "$APP_DIR/data"
  as_root chmod 700 "$APP_DIR/data"
  chmod +x "$APP_DIR/install.sh" "$APP_DIR/manage.sh"

  BUILD_LOG="$(mktemp)"
  chmod 600 "$BUILD_LOG"
  progress 55 "Building the isolated runtime"
  if ! compose build >"$BUILD_LOG" 2>&1; then
    say "${RED}Docker build failed. Last output:${RESET}"
    tail -n 80 "$BUILD_LOG" >&4
    exit 1
  fi

  progress 72 "Validating the Polyester account and API policy"
  : >"$BUILD_LOG"
  if ! compose run --rm --no-deps bot node --enable-source-maps dist/tools/private-read-smoke.js >"$BUILD_LOG" 2>&1; then
    say "${RED}Polyester rejected the API credentials or read policy.${RESET}"
    tail -n 60 "$BUILD_LOG" >&4
    exit 1
  fi

  local configured_mode
  configured_mode="$(sed -n 's/^TRADING_MODE=//p' "$APP_DIR/.env" | tail -n 1)"
  if [[ "$configured_mode" == "live" ]]; then
    progress 80 "Checking non-mutating order preview permission"
    : >"$BUILD_LOG"
    if ! compose run --rm --no-deps bot node --enable-source-maps dist/tools/live-preview-smoke.js >"$BUILD_LOG" 2>&1; then
      say "${RED}Polyester rejected the trading preview. Check the trade policy and market scope.${RESET}"
      tail -n 60 "$BUILD_LOG" >&4
      exit 1
    fi
  fi

  progress 88 "Starting the private Telegram instance"
  : >"$BUILD_LOG"
  if ! compose up -d >"$BUILD_LOG" 2>&1; then
    say "${RED}Container startup failed. Last output:${RESET}"
    tail -n 80 "$BUILD_LOG" >&4
    exit 1
  fi

  progress 94 "Waiting for Telegram initialization"
  local attempt logs
  for attempt in {1..45}; do
    logs="$(compose logs --no-color --tail=120 bot 2>/dev/null || true)"
    if [[ "$logs" == *'"message":"bot_started"'* ]]; then
      progress 100 "Ready"
      return
    fi
    if [[ "$logs" == *'"message":"startup_failed"'* ]]; then
      say "${RED}The bot rejected the configuration during startup.${RESET}"
      printf '%s\n' "$logs" | tail -n 40 >&4
      exit 1
    fi
    sleep 1
  done

  say "${RED}The container did not reach Ready state within 45 seconds.${RESET}"
  compose logs --no-color --tail=60 bot >&4 || true
  exit 1
}

main() {
  parse_arguments "$@"
  banner
  show_disclaimer
  progress 5 "Installer accepted"
  ensure_host_tools
  progress 20 "Docker, Compose, Git and TLS tools available"
  resolve_application
  progress 35 "Application files ready"

  local keep_existing=false
  if [[ -f "$APP_DIR/.env" && "$FORCE_RECONFIGURE" != true ]]; then
    say ""
    say "${YELLOW}An existing protected configuration was found.${RESET}"
    say "  ${GREEN}1)${RESET} Keep it and deploy"
    say "  ${YELLOW}2)${RESET} Replace it using the setup wizard"
    say "  ${RED}3)${RESET} Exit"
    local existing_choice
    choose "Selection" existing_choice 1 3
    case "$existing_choice" in
      1) keep_existing=true ;;
      2) keep_existing=false ;;
      3) exit 0 ;;
    esac
  fi

  if [[ "$keep_existing" != true ]]; then
    collect_configuration
    write_environment
  fi
  progress 50 "Protected local configuration saved"

  select_docker
  deploy
  say ""
  say "${GREEN}${BOLD}✓ Polyester Trading Terminal is running.${RESET}"
  say "Open the bot in Telegram and send ${BOLD}/start${RESET}."
  say ""
  say "Management menu:"
  say "  ${CYAN}cd \"$APP_DIR\" && ./manage.sh${RESET}"
  say ""
}

main "$@"
