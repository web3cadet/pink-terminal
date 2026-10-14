"""Exercise the Ubuntu retry menu with a fake Compose command, never a real bot."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1].joinpath("install.sh").read_text(encoding="utf-8")

def function(name):
    return re.search(r"^" + name + r"\(\) \{.*?^\}", SOURCE, re.M | re.S).group(0)

class SetupAccessTest(unittest.TestCase):
    def test_retry_then_replace_preserves_other_settings(self):
        with tempfile.TemporaryDirectory(prefix="pink-access-check-") as root:
            config = Path(root, ".env")
            config.write_text("TELEGRAM_BOT_TOKEN=fixture\nPOLYESTER_SUBACCOUNT_ID=42\nTRADING_MODE=live\nCUSTOM=keep\nPOLYESTER_API_KEY_ID=old\nPOLYESTER_API_SECRET_HEX=old\n")
            script = "set -eu\nexec 3<&0 4>&1\nAPP_DIR=\"$TEST_ROOT\"\nPINK='' BOLD='' RESET='' GREEN='' YELLOW=''\n"
            script += "say() { printf '%s\\n' \"$*\" >&4; }\n"
            script += "\n".join(function(name) for name in ["read_value", "read_secret", "collect_api_key", "replace_api_key", "check_api_access"])
            script += "\nattempts=0\ncompose() { attempts=$((attempts + 1)); test \"$attempts\" -eq 3; }\ncheck_api_access\nprintf 'ATTEMPTS=%s\\n' \"$attempts\"\n"
            seed = "a" * 64
            result = subprocess.run(["bash", "-c", script], input="\n2\nak_1234567890abcdef\n" + seed + "\n", text=True, capture_output=True, timeout=10, env={**os.environ, "TEST_ROOT": root})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("ATTEMPTS=3", result.stdout)
            self.assertNotIn(seed, result.stdout)
            updated = config.read_text()
            self.assertIn("TELEGRAM_BOT_TOKEN=fixture\n", updated)
            self.assertIn("POLYESTER_SUBACCOUNT_ID=42\n", updated)
            self.assertIn("CUSTOM=keep\n", updated)
            self.assertIn("POLYESTER_API_KEY_ID=ak_1234567890abcdef\n", updated)
            self.assertIn("POLYESTER_API_SECRET_HEX=" + seed, updated)

if __name__ == "__main__":
    unittest.main()
