import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'uninstall-linux.py'


class UninstallTests(unittest.TestCase):
    def run_helper(self, root, mode):
        home = Path(root).parent / 'home'
        home.mkdir(exist_ok=True)
        return subprocess.run([sys.executable, str(SCRIPT), mode], cwd=root, capture_output=True, text=True,
                              env={**os.environ, 'HOME': str(home), 'USERPROFILE': str(home)})

    def test_check_and_delete(self):
        with tempfile.TemporaryDirectory(prefix='pink-linux-uninstall-test-') as directory:
            root = Path(directory, 'app')
            root.mkdir()
            (root / 'package.json').write_text(json.dumps({'name': 'pink-terminal'}))
            (root / '.env').write_text('TEST_ONLY=keep\n')
            (root / 'data').mkdir()
            (root / 'data' / 'history').write_text('test')
            checked = self.run_helper(root, '--check')
            self.assertEqual(checked.returncode, 0, checked.stderr)
            self.assertTrue((root / 'data').exists())
            deleted = self.run_helper(root, '--delete')
            self.assertEqual(deleted.returncode, 0, deleted.stderr)
            self.assertFalse(root.exists())
            backups = list(Path(directory, 'home').glob('pink-terminal-backup-*/.env'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(), 'TEST_ONLY=keep\n')
            if os.name != 'nt':
                self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
            root.mkdir()  # Reinstallation can reuse the exact destination.

    def test_wrong_package(self):
        with tempfile.TemporaryDirectory(prefix='pink-linux-uninstall-test-') as directory:
            root = Path(directory, 'app')
            root.mkdir()
            (root / 'package.json').write_text('{"name":"another-app"}')
            self.assertNotEqual(self.run_helper(root, '--delete').returncode, 0)
            self.assertTrue((root / 'package.json').exists())

    def test_unrelated_files_block_all_deletion(self):
        with tempfile.TemporaryDirectory(prefix='pink-linux-uninstall-test-') as directory:
            root = Path(directory, 'app')
            root.mkdir()
            (root / 'package.json').write_text('{"name":"pink-terminal"}')
            (root / '.env').write_text('TEST_ONLY=keep')
            (root / 'personal.txt').write_text('keep')
            self.assertNotEqual(self.run_helper(root, '--delete').returncode, 0)
            self.assertTrue((root / 'package.json').exists())
            self.assertTrue((root / '.env').exists())
            self.assertTrue((root / 'personal.txt').exists())


if __name__ == '__main__':
    unittest.main()
