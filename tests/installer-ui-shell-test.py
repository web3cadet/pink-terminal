"""Ubuntu installer UI regression checks using fake commands, no packages or bots."""
import os
import re
import subprocess
import tempfile
import sys
import shutil
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1].joinpath("install.sh").read_text(encoding="utf-8")


def function(name):
    return re.search(r"^" + name + r"\(\) \{.*?^\}", SOURCE, re.M | re.S).group(0)


class InstallerUiTest(unittest.TestCase):
    def run_script(self, names, body, env=None):
        script = "set -eu\nexec 4>&1\nPINK='' GREEN='' CYAN='' RED='' DIM='' BOLD='' RESET=''\n"
        script += "INSTALL_LOG_DIR='' SPINNER_PID=''\numask 077\nsay() { printf '%b\\n' \"$*\" >&4; }\n"
        # Deterministic no-TTY defaults; individual tests replace these probes.
        script += "stty() { return 1; }; tput() { return 1; }; exec 3</dev/null\n"
        if 'banner' in names:
            names = ['terminal_columns', 'banner_width', 'banner_line'] + names
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

    def test_actual_tty_width_wins_over_stale_environment(self):
        result = self.run_script(['banner'], 'stty() { echo "40 140"; }; banner', {'COLUMNS': '80', 'LC_ALL': 'C'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum('█' in line or '╚' in line for line in result.stdout.splitlines()), 6)

    def test_width_fallbacks_and_invalid_values(self):
        cases = [
            ('stty() { echo "30 39"; }; tput() { echo 140; };', '80', '39'),
            ('stty() { echo "0 0"; }; tput() { [[ -z "${COLUMNS:-}" && -z "${LINES:-}" ]] || return 1; echo 100; };', '80', '100'),
            ('', '42', '42'), ('', '0', '80'), ('', '-1', '80'),
            ('', 'garbage', '80'), ('', '99999999999999999999', '80'),
        ]
        for probes, columns, expected in cases:
            with self.subTest(columns=columns, expected=expected):
                result = self.run_script(['terminal_columns'], probes + ' terminal_columns', {'COLUMNS': columns, 'LINES': '24'})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, expected)

    def test_banner_fits_mobile_and_desktop_in_both_locales(self):
        for locale in ['C', 'C.UTF-8']:
            for columns in [8, 12, 13, 20, 30, 31, 32, 39, 60, 63, 64, 65, 80, 96, 100, 120, 140, 200]:
                with self.subTest(locale=locale, columns=columns):
                    result = self.run_script(['banner'], 'banner', {'COLUMNS': str(columns), 'LC_ALL': locale})
                    self.assertEqual(result.returncode, 0, result.stderr)
                    text = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', result.stdout)
                    self.assertTrue(all(len(line) <= columns for line in text.splitlines()), repr(text))
                    if columns < 31:
                        self.assertIn('PINK', text)
                        self.assertIn('TERMINAL', text)
                    elif columns < 63:
                        self.assertEqual(sum('█' in line for line in text.splitlines()), 10)

    def test_width_is_measured_again_on_next_render(self):
        result = self.run_script(['banner'], 'stty() { echo "30 $TEST_WIDTH"; }; TEST_WIDTH=140; banner; echo SPLIT; TEST_WIDTH=39; banner')
        self.assertEqual(result.returncode, 0, result.stderr)
        wide, narrow = result.stdout.split('SPLIT')
        self.assertEqual(sum('█' in line or '╚' in line for line in wide.splitlines()), 6)
        self.assertEqual(sum('█' in line for line in narrow.splitlines()), 10)

    @unittest.skipIf(os.name == 'nt', 'POSIX pseudo-terminal test runs on Linux/macOS')
    def test_real_pty_size_with_piped_stdin_and_stale_columns(self):
        import fcntl
        import pty
        import struct
        import termios
        master, slave = pty.openpty()
        try:
            script = 'set -eu\nexec 3<&' + str(slave) + '\n' + function('terminal_columns') + '\nterminal_columns'
            for columns in [140, 39, 80]:
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, columns, 0, 0))
                result = subprocess.run(['bash', '-c', script], input='', capture_output=True, text=True,
                                        pass_fds=(slave,), timeout=5,
                                        env={**os.environ, 'COLUMNS': '80', 'LC_ALL': 'C'})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, str(columns))
        finally:
            os.close(master)
            os.close(slave)

    def test_old_uninstall_residue_is_backed_up_and_destination_can_be_reused(self):
        with tempfile.TemporaryDirectory(prefix="pink-residue-") as base:
            root = Path(base, 'app'); root.mkdir()
            home = Path(base, 'home'); home.mkdir()
            (root / '.env').write_text('SYNTHETIC=keep\n')
            (root / '.github' / 'workflows').mkdir(parents=True)
            (root / '.github' / 'workflows' / 'platform-checks.yml').write_text('fixture')
            body = 'python3() { "$TEST_PYTHON" "$@"; }; preserve_install_residue "$TEST_ROOT" prepare'
            env = {"TEST_ROOT": root.as_posix(), "TEST_PYTHON": Path(sys.executable).as_posix(), "HOME": home.as_posix(), "USERPROFILE": home.as_posix()}
            result = self.run_script(["preserve_install_residue"], body, env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(root.is_dir())
            self.assertEqual(list(root.iterdir()), [])
            backups = list(home.glob('pink-terminal-backup-*'))
            self.assertEqual(len(backups), 1)
            self.assertEqual((backups[0] / '.env').read_text(), 'SYNTHETIC=keep\n')
            self.assertTrue((backups[0] / '.github/workflows/platform-checks.yml').exists())

    def test_residue_recovery_refuses_unrelated_files(self):
        with tempfile.TemporaryDirectory(prefix="pink-residue-") as base:
            root = Path(base, 'app'); root.mkdir()
            (root / 'personal.txt').write_text('keep')
            body = 'python3() { "$TEST_PYTHON" "$@"; }; preserve_install_residue "$TEST_ROOT" cancel'
            result = self.run_script(["preserve_install_residue"], body, {"TEST_ROOT": root.as_posix(), "TEST_PYTHON": Path(sys.executable).as_posix()})
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((root / 'personal.txt').read_text(), 'keep')

    def test_first_disclaimer_exit_calls_cleanup_not_installation(self):
        result = self.run_script(["show_disclaimer"], '''
YELLOW=''
choose() { answer=2; }
cancel_installation() { echo CLEANUP; }
show_disclaimer
echo MUST_NOT_CONTINUE
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("CLEANUP", result.stdout)
        self.assertIn("Exit [bot will be uninstalled; .env backed up]", result.stdout)
        self.assertNotIn("MUST_NOT_CONTINUE", result.stdout)

    def test_real_linux_uninstall_helper_and_manager_notice_in_isolated_folder(self):
        with tempfile.TemporaryDirectory(prefix="pink-uninstall-flow-") as base:
            root = Path(base, 'app'); root.mkdir()
            home = Path(base, 'home'); home.mkdir()
            (root / 'package.json').write_text('{"name":"pink-terminal"}')
            (root / '.env').write_text('SYNTHETIC=keep\n')
            (root / 'scripts').mkdir()
            project = Path(__file__).resolve().parents[1]
            for name in ['uninstall-linux.py', 'uninstall-files.json']:
                shutil.copyfile(project / 'scripts' / name, root / 'scripts' / name)
            manager = (project / 'manage.sh').read_text(encoding='utf-8')
            uninstall = re.search(r'^uninstall_bot\(\) \{.*?^\}', manager, re.M | re.S).group(0)
            body = uninstall + '''
APP_DIR="$TEST_ROOT"
YELLOW=''
python3() { "$TEST_PYTHON" "$@"; }
compose() { [[ "$*" == down ]] || return 9; }
cd "$APP_DIR"
uninstall_bot --installer-cancel
'''
            env = {"TEST_ROOT": root.as_posix(), "TEST_PYTHON": Path(sys.executable).as_posix(), "HOME": home.as_posix(), "USERPROFILE": home.as_posix()}
            result = self.run_script([], body, env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertFalse(root.exists())
            self.assertIn('REINSTALL · RETURN TO YOUR HOME FOLDER', result.stdout)
            self.assertIn('cd "$HOME"', result.stdout)
            backups = list(home.glob('pink-terminal-backup-*/.env'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(), 'SYNTHETIC=keep\n')

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
