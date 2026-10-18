#!/usr/bin/env bash

# Called by installers/managers after compose up. Inspect the current container,
# and only accept readiness from its current start (never from older log entries).
wait_for_container_ready() {
  local attempts="${1:-45}" delay="${2:-1}" attempt container state started logs after
  for ((attempt=0; attempt<attempts; attempt++)); do
    container="$(compose ps -q bot 2>/dev/null || true)"
    if [[ -n "$container" ]]; then
      state="$("${DOCKER[@]}" inspect --format '{{.State.Running}}|{{.State.StartedAt}}|{{.RestartCount}}' "$container" 2>/dev/null || true)"
      if [[ "$state" == true\|* ]]; then
        started="${state#*|}"; started="${started%%|*}"
        logs="$("${DOCKER[@]}" logs --since "$started" --tail 120 "$container" 2>&1 || true)"
        after="$("${DOCKER[@]}" inspect --format '{{.State.Running}}|{{.State.StartedAt}}|{{.RestartCount}}' "$container" 2>/dev/null || true)"
        if [[ "$state" == "$after" ]]; then
          if [[ "$logs" == *'"message":"startup_failed"'* ]]; then
            say "Startup failed. Check Recent logs."
            return 1
          fi
          if [[ "$logs" == *'"message":"bot_started"'* && "$logs" != *'"message":"shutdown_started"'* ]]; then return 0; fi
        fi
      fi
    fi
    sleep "$delay"
  done
  say "Telegram readiness was not confirmed. Check Status and Recent logs."
  return 1
}
