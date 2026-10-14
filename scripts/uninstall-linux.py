"""Bounded Linux cleanup, called by manage.sh after confirmation and Docker shutdown."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def plan(directory):
    root = Path(directory).absolute()
    if root != root.resolve() or str(root) in ('/', '/root', '/home', '/opt', '/usr', '/var', '/tmp') or root == Path.home():
        raise RuntimeError('Refusing a linked or broad directory')
    package = root / 'package.json'
    if package.is_symlink() or json.loads(package.read_text())['name'] != 'pink-terminal':
        raise RuntimeError('Not a Pink Terminal installation')
    names = json.loads((Path(__file__).parent / 'uninstall-files.json').read_text())
    if (root / '.git').exists():
        # install.sh adds executable bits; these alone are not user content changes.
        result = subprocess.run(['git', '-C', str(root), '-c', 'core.fileMode=false', 'status', '--porcelain'], capture_output=True, text=True, check=True)
        if result.stdout.strip():
            raise RuntimeError('Source checkout has local changes or untracked files. Back them up before uninstalling.')
        names.append('.git')
    targets = [root / name for name in names if (root / name).exists()]
    for target in targets:
        if target.name.lower() == '.env' or target.parent != root or target.is_symlink() or target.resolve() != target:
            raise RuntimeError('Refusing linked or out-of-folder target')
        if target.is_dir():
            def denied(error):
                raise error
            for directory, _, _ in os.walk(target, followlinks=False, onerror=denied):
                if not os.access(directory, os.R_OK | os.W_OK | os.X_OK):
                    raise RuntimeError('Insufficient directory permissions; no deletion started')
    return targets


if __name__ == '__main__':
    try:
        targets = plan(os.getcwd())
        if sys.argv[1:] == ['--delete']:
            for target in targets:
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
        elif sys.argv[1:] != ['--check']:
            raise RuntimeError('Use --check or --delete via manage.sh')
    except Exception as error:
        print(f'Uninstall stopped: {error}', file=sys.stderr)
        sys.exit(1)
