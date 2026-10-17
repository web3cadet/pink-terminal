#!/usr/bin/env bash
set -Eeuo pipefail

PINK='\033[38;2;250;47;111m'
GREEN='\033[38;2;70;211;105m'
CYAN='\033[38;2;72;199;235m'
YELLOW='\033[38;2;255;196;61m'
RED='\033[38;2;255;92;92m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if [[ -r /dev/tty && -w /dev/tty ]]; then
  exec 3</dev/tty 4>/dev/tty
else
  exec 3<&0 4>&1
fi

say() { printf '%b\n' "$*" >&4; }

if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif [[ "$EUID" -ne 0 ]] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
  DOCKER=(sudo docker)
else
  say "${RED}Docker is unavailable.${RESET}"
  exit 1
fi

compose() {
  "${DOCKER[@]}" compose --project-directory "$APP_DIR" -f "$APP_DIR/docker-compose.yml" "$@"
}

source "$APP_DIR/scripts/docker-ready.sh"

pause() {
  say ""
  printf '%b' "${DIM}Press Enter to return to the menu…${RESET}" >&4
  IFS= read -r _ <&3
}

header() {
  printf '\033[2J\033[H' >&4
  say "${PINK}${BOLD}PINK TERMINAL${RESET}"
  say "${DIM}Self-hosted instance manager${RESET}"
  say ""
}

show_status() {
  if compose ps --status running --services 2>/dev/null | grep -qx bot; then
    say "Status: ${GREEN}${BOLD}RUNNING${RESET}"
  else
    say "Status: ${RED}${BOLD}STOPPED${RESET}"
  fi
}

uninstall_bot() {
  command -v python3 >/dev/null 2>&1 || { say "Python 3 is required for safe uninstall."; return 1; }
  python3 "$APP_DIR/scripts/uninstall-linux.py" --check || return 1
  say "Uninstall from: $APP_DIR"
  say "Backs up .env in your home folder, then removes the installation folder, Git checkout, local history and logs."
  say "Unrelated files block removal. Keep personal files outside the installation."
  say "Exchange orders and strategies are NOT cancelled. Close them first if required."
  say "Docker, shared images/cache and the Telegram bot account are NOT removed."
  if [[ "${1:-}" != --installer-cancel ]]; then
    printf '%s' "Are you sure? Type DELETE to uninstall (Enter cancels): " >&4
    IFS= read -r confirmation <&3
    if [[ "$confirmation" != DELETE ]]; then say "Uninstall cancelled. Nothing changed."; return 0; fi
  fi
  compose down || return 1
  python3 "$APP_DIR/scripts/uninstall-linux.py" --delete || return 1
  cd "$HOME"
  say "${GREEN}${BOLD}UNINSTALLED · Installation folder removed. Configuration backup saved if .env existed.${RESET}"
  say ""
  say "${PINK}${BOLD}REINSTALL · RETURN TO YOUR HOME FOLDER${RESET}"
  say "Your terminal may still point to the deleted folder. Before reinstalling, run:"
  say '  cd "$HOME"'
  say "${DIM}For root this opens /root. Then run the installer again.${RESET}"
  exit 0
}

if [[ "${1:-}" == uninstall ]]; then uninstall_bot "${2:-}"; exit $?; fi

update_bot() {
  if [[ ! -d "$APP_DIR/.git" ]]; then
    say "${YELLOW}This copy is not a Git checkout, so automatic update is unavailable.${RESET}"
    return 1
  fi
  if git pull --ff-only && compose up -d --build && wait_for_container_ready; then
    say "${GREEN}Update completed and the bot was rebuilt.${RESET}"
  else
    say "${RED}Update failed. Check Status and Recent logs before retrying.${RESET}"
    return 1
  fi
}

if [[ "${1:-}" == update ]]; then update_bot; exit $?; fi

while true; do
  header
  show_status
  say ""
  say "  ${GREEN}1)${RESET} Start"
  say "  ${YELLOW}2)${RESET} Stop"
  say "  ${CYAN}3)${RESET} Restart"
  say "  ${CYAN}4)${RESET} Status details"
  say "  ${CYAN}5)${RESET} Recent logs"
  say "  ${PINK}6)${RESET} Reconfigure"
  say "  ${PINK}7)${RESET} Update from Git and rebuild"
  say "  ${RED}8)${RESET} Uninstall (back up .env)"
  say "  ${DIM}0)${RESET} Exit"
  say ""
  printf '%b' "${BOLD}Selection:${RESET} " >&4
  IFS= read -r choice <&3

  case "$choice" in
    1)
      if compose up -d && wait_for_container_ready; then say "${GREEN}Bot started.${RESET}"; fi
      pause
      ;;
    2)
      compose stop bot
      say "${YELLOW}Bot stopped. Local data is preserved.${RESET}"
      pause
      ;;
    3)
      if compose up -d --force-recreate bot && wait_for_container_ready; then say "${GREEN}Bot restarted.${RESET}"; fi
      pause
      ;;
    4)
      compose ps
      pause
      ;;
    5)
      compose logs --no-color --tail=100 bot
      pause
      ;;
    6)
      bash "$APP_DIR/install.sh" --reconfigure
      ;;
    7)
      update_bot || true
      pause
      ;;
    8) uninstall_bot; pause ;;
    0) exit 0 ;;
    *)
      say "${YELLOW}Choose a number from 0 to 8.${RESET}"
      sleep 1
      ;;
  esac
done
