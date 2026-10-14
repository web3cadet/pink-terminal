import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'uninstall-linux.py'


class UninstallTests(unittest.TestCase):
    def run_helper(self, root, mode):
        return subprocess.run([sys.executable, str(SCRIPT), mode], cwd=root, capture_output=True, text=True)

    def test_check_and_delete(self):
        with tempfile.TemporaryDirectory(prefix='pink-linux-uninstall-test-') as directory:
            root = Path(directory)
            (root / 'package.json').write_text(json.dumps({'name': 'pink-terminal'}))
            (root / '.env').write_text('TEST_ONLY=keep\n')
            (root / 'personal.txt').write_text('keep')
            (root / 'data').mkdir()
            (root / 'data' / 'history').write_text('test')
            checked = self.run_helper(root, '--check')
            self.assertEqual(checked.returncode, 0, checked.stderr)
            self.assertTrue((root / 'data').exists())
            deleted = self.run_helper(root, '--delete')
            self.assertEqual(deleted.returncode, 0, deleted.stderr)
            self.assertEqual((root / '.env').read_text(), 'TEST_ONLY=keep\n')
            self.assertTrue((root / 'personal.txt').exists())
            self.assertFalse((root / 'data').exists())
            self.assertFalse((root / 'package.json').exists())

    def test_wrong_package(self):
        with tempfile.TemporaryDirectory(prefix='pink-linux-uninstall-test-') as directory:
            root = Path(directory)
            (root / 'package.json').write_text('{"name":"another-app"}')
            self.assertNotEqual(self.run_helper(root, '--delete').returncode, 0)
            self.assertTrue((root / 'package.json').exists())


if __name__ == '__main__':
    unittest.main()
