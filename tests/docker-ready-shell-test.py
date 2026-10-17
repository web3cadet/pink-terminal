"""Readiness contract tested against fake Docker, never a running bot."""
import subprocess
from pathlib import Path
import unittest

HELPER = Path(__file__).resolve().parents[1].joinpath("scripts/docker-ready.sh").read_text(encoding="utf-8")


class DockerReadyTest(unittest.TestCase):
    def check_case(self, state, log_mode, expected):
        script = "set -eu\n" + HELPER + "\n"
        script += "say() { printf '%s\\n' \"$*\"; }; compose() { echo fixture; }; DOCKER=(docker)\n"
        script += "docker() { if [[ $1 == inspect ]]; then printf '%s\\n' '" + state + "'; else "
        # Fail unless the helper bounds logs to the exact current startup timestamp.
        script += "[[ $1 == logs && $2 == --since && $3 == current-start ]] || return 9; "
        if log_mode == "ready":
            script += "echo '{\"message\":\"bot_started\"}'; "
        elif log_mode == "failed":
            script += "echo '{\"message\":\"bot_started\"}'; echo '{\"message\":\"startup_failed\"}' >&2; "
        elif log_mode == "stopping":
            script += "echo '{\"message\":\"bot_started\"}'; echo '{\"message\":\"shutdown_started\"}'; "
        else:
            script += ":; "
        script += "fi; }; wait_for_container_ready 1 0\n"
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_current_ready(self): self.check_case("true|current-start|0", "ready", 0)
    def test_old_logs_are_not_readiness(self): self.check_case("true|current-start|0", "empty", 1)
    def test_exited_container_is_not_ready(self): self.check_case("false|current-start|0", "ready", 1)
    def test_startup_failure_wins(self): self.check_case("true|current-start|0", "failed", 1)
    def test_stopping_is_not_ready(self): self.check_case("true|current-start|0", "stopping", 1)


if __name__ == "__main__": unittest.main()
