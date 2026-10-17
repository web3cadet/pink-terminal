"""Ubuntu installer UI regression checks using fake commands, no packages or bots."""
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1].joinpath("install.sh").read_text(encoding="utf-8")


def function(name):
    return re.search(r"^" + name + r"\(\) \{.*?^\}", SOURCE, re.M | re.S).group(0)


class InstallerUiTest(unittest.TestCase):
    def run_script(self, names, body, env=None):
        script = "set -eu\nexec 4>&1\nPINK='' GREEN='' CYAN='' RED='' DIM='' BOLD='' RESET=''\n"
        script += "INSTALL_LOG_DIR='' SPINNER_PID=''\numask 077\nsay() { printf '%b\\n' \"$*\" >&4; }\n"
        script += "\n".join(function(name) for name in names) + "\n" + body
        return subprocess.run(["bash", "-c", script], capture_output=True, encoding="utf-8", timeout=15,
                              env={**os.environ, **(env or {})})

    def test_full_name_and_single_percent(self):
        result = self.run_script(["banner", "progress"], 'banner; progress 55 "Building"', {"COLUMNS": "140"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("██████╗ ██╗███╗   ██╗██╗  ██╗", result.stdout)
        self.assertIn("██╗███╗   ██╗ █████╗ ██╗", result.stdout)
        self.assertEqual(sum('█' in line or '╚' in line for line in result.stdout.splitlines()), 7)
        self.assertNotIn("╭", result.stdout)
        self.assertIn("55%", result.stdout)
        self.assertNotIn("%%", result.stdout)

    def test_narrow_banner_keeps_both_full_words_in_block_letters(self):
        result = self.run_script(["banner"], 'banner', {"COLUMNS": "80"})
        self.assertEqual(result.returncode, 0, result.stderr)
        art = [line for line in result.stdout.splitlines() if '█' in line or '╚' in line]
        self.assertEqual(len(art), 12)
        self.assertTrue(all(len(line) <= 80 for line in art))
        self.assertIn("██╗███╗   ██╗ █████╗ ██╗", result.stdout)

    def test_apt_policy_is_scoped_after_privilege_boundary_and_cannot_read_input(self):
        result = self.run_script(["install_host_packages"], '''
as_root() {
  printf '%s\\n' "$@"
  if IFS= read -r input; then echo UNEXPECTED_INPUT; return 99; fi
}
install_host_packages install -y docker.io
[[ -z "${DEBIAN_FRONTEND:-}" && -z "${NEEDRESTART_MODE:-}" ]]
''', {"DEBIAN_FRONTEND": "", "NEEDRESTART_MODE": ""})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("env\nDEBIAN_FRONTEND=noninteractive\nNEEDRESTART_MODE=l\napt-get", result.stdout)
        self.assertIn("Dpkg::Options::=--force-confold", result.stdout)
        self.assertNotIn("UNEXPECTED_INPUT", result.stdout)
        self.assertNotIn("NEEDRESTART_MODE=a", result.stdout)

    def test_reboot_notice_is_informational_and_conditional(self):
        with tempfile.TemporaryDirectory(prefix="pink-reboot-notice-") as root:
            marker = Path(root, "reboot-required")
            marker.touch()
            env = {"TEST_MARKER": marker.as_posix()}
            body = 'YELLOW=""; show_host_notice "$TEST_MARKER"'
            result = self.run_script(["show_host_notice"], body, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("SYSTEM NOTICE", result.stdout)
            self.assertIn("will not reboot", result.stdout)
            marker.unlink()
            result = self.run_script(["show_host_notice"], body, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")

    def test_logs_hidden_retained_and_failure_status_preserved(self):
        with tempfile.TemporaryDirectory(prefix="pink-installer-ui-") as root:
            result = self.run_script(["stop_spinner", "run_logged"], '''
ok() { echo PACKAGE_NOISE; echo STDERR_NOISE >&2; }
fail() { echo FAILURE_DETAILS; return 7; }
run_logged "Host tools" ok
if run_logged "Build" fail; then exit 99; else status=$?; fi
printf 'STATUS=%s\\n' "$status"
''', {"TMPDIR": Path(root).as_posix(), "TERM": "dumb"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("STATUS=7", result.stdout)
            self.assertIn("Diagnostic log:", result.stdout)
            self.assertNotIn("PACKAGE_NOISE", result.stdout)
            self.assertNotIn("STDERR_NOISE", result.stdout)
            self.assertNotIn("FAILURE_DETAILS", result.stdout)
            logs = list(Path(root).rglob("*.log"))
            self.assertEqual(len(logs), 2)
            saved = "".join(p.read_text() for p in logs)
            self.assertIn("PACKAGE_NOISE", saved)
            self.assertIn("FAILURE_DETAILS", saved)
            if os.name != "nt":
                self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in logs))

    def test_command_failure_aborts_the_install_stage(self):
        with tempfile.TemporaryDirectory(prefix="pink-installer-ui-") as root:
            result = self.run_script(["stop_spinner", "run_logged"], '''
fail() { return 9; }
run_logged "Host tools" fail
echo SHOULD_NOT_DEPLOY
''', {"TMPDIR": Path(root).as_posix()})
            self.assertEqual(result.returncode, 9, result.stderr)
            self.assertNotIn("SHOULD_NOT_DEPLOY", result.stdout)

    def test_fresh_configuration_defaults_live_without_mode_prompt(self):
        result = self.run_script(["collect_configuration"], '''
read_secret() { TELEGRAM_TOKEN=123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ; }
validate_telegram_token() { return 0; }
read_value() { case "$2" in TELEGRAM_USER_ID) TELEGRAM_USER_ID=123456;; SUBACCOUNT_ID) SUBACCOUNT_ID='';; esac; }
collect_api_key() { API_KEY_ID=fixture; }
choose() { [[ "$2" == confirmation ]] || exit 99; confirmation=1; }
YELLOW=''
collect_configuration
echo "MODE=$TRADING_MODE"
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("MODE=live", result.stdout)
        self.assertNotIn("Paper", result.stdout)
        self.assertNotIn("Read-only", result.stdout)

    def test_link_uses_container_config_not_shell_credentials(self):
        result = self.run_script(["show_telegram_link"], '''
compose() { [[ "$*" == 'exec -T bot node dist/tools/telegram-link.js' ]] || return 8; echo https://t.me/Pink_Test_Bot; }
show_telegram_link
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("https://t.me/Pink_Test_Bot", result.stdout)

    def test_link_failure_does_not_hide_success_or_leak_output(self):
        for command in ["echo SECRET_ERROR >&2; return 1", "echo SECRET_BAD_RESPONSE"]:
            result = self.run_script(["show_telegram_link"], "compose() { " + command + "; }; show_telegram_link")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Bot is running", result.stdout)
            self.assertNotIn("SECRET", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
