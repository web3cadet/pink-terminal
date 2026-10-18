"""Bounded Linux cleanup, called by manage.sh after confirmation and Docker shutdown."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

NAMES = json.loads(Path(__file__).with_name('uninstall-files.json').read_text())


def plan(directory):
    root = Path(directory).absolute()
    if root != root.resolve() or str(root) in ('/', '/root', '/home', '/opt', '/usr', '/var', '/tmp') or root == Path.home():
        raise RuntimeError('Refusing a linked or broad directory')
    package = root / 'package.json'
    if package.is_symlink() or json.loads(package.read_text())['name'] != 'pink-terminal':
        raise RuntimeError('Not a Pink Terminal installation')
    names = list(NAMES)
    if (root / '.git').exists():
        # install.sh adds executable bits; these alone are not user content changes.
        result = subprocess.run(['git', '-C', str(root), '-c', 'core.fileMode=false', 'status', '--porcelain'], capture_output=True, text=True, check=True)
        if result.stdout.strip():
            raise RuntimeError('Source checkout has local changes or untracked files. Back them up before uninstalling.')
        names.append('.git')
    names.append('.env')
    if any(child.name not in names for child in root.iterdir()):
        raise RuntimeError('Unrelated files found. Move them out before uninstalling; nothing was deleted.')
    targets = list(root.iterdir())
    for target in targets:
        if target.parent != root or target.is_symlink() or target.resolve() != target:
            raise RuntimeError('Refusing linked or out-of-folder target')
        if target.name == '.env' and (not target.is_file() or target.stat().st_nlink != 1):
            raise RuntimeError('Configuration must be an ordinary unlinked file')
        if target.is_dir():
            def denied(error):
                raise error
            for directory, _, _ in os.walk(target, followlinks=False, onerror=denied):
                if not os.access(directory, os.R_OK | os.W_OK | os.X_OK):
                    raise RuntimeError('Insufficient directory permissions; no deletion started')
    return targets


def remove(directory, backup_home=None):
    root = Path(directory).absolute()
    targets = plan(root)
    home = Path(backup_home or Path.home()).resolve()
    if home == root or root in home.parents:
        raise RuntimeError('Backup must be outside the installation')
    env = root / '.env'
    if env.exists():
        content = env.read_bytes()
        backup_dir = Path(tempfile.mkdtemp(prefix='pink-terminal-backup-', dir=home))
        os.chmod(backup_dir, 0o700)
        backup = backup_dir / '.env'
        descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        if backup.read_bytes() != content:
            raise RuntimeError('Configuration backup verification failed; nothing was deleted')
        print(f'Configuration backup: {backup}', flush=True)
    plan(root)
    if env.exists() and env.read_bytes() != content:
        raise RuntimeError('Configuration changed during backup; deletion cancelled')
    os.chdir(home)
    for target in targets:
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
    root.rmdir()
    print('Installation folder removed.', flush=True)


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--delete']:
            remove(os.getcwd())
        elif sys.argv[1:] == ['--check']:
            plan(os.getcwd())
        else:
            raise RuntimeError('Use --check or --delete via manage.sh')
    except Exception as error:
        print(f'Uninstall stopped: {error}', file=sys.stderr)
        sys.exit(1)
