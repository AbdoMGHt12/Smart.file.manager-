import json
import shutil
import time
from pathlib import Path

import webview

from scanner import scan_folder

APP_DATA_DIR = Path.home() / '.fileguard'
TRASH_DIR = APP_DATA_DIR / 'trash'
MANIFEST_PATH = APP_DATA_DIR / 'trash_manifest.json'

APP_DATA_DIR.mkdir(exist_ok=True)
TRASH_DIR.mkdir(exist_ok=True)


def _load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        try:
            return json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
        except Exception:
            return {}
    return {}


def _save_manifest(data: dict) -> None:
    MANIFEST_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


class FileGuardAPI:
    def selectFolder(self):
        result = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG)
        if result:
            return result[0]
        return None

    def startScan(self, folder, options):
        try:
            return scan_folder(folder, options or {})
        except Exception as e:
            return {
                'folder': folder,
                'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S'),
                'stats': {'scanned': 0, 'issues': 0, 'recoverable': '0 MB'},
                'distribution': {'media': '0 MB', 'docs': '0 MB', 'archives': '0 MB'},
                'groups': [],
                'error': str(e),
            }

    def moveToTrash(self, file_paths):
        """Moves real files into an app-managed trash folder and returns a
        trash id the frontend should remember, so it can request an undo later."""
        trash_id = f"undo_{int(time.time() * 1000)}"
        trash_folder = TRASH_DIR / trash_id
        trash_folder.mkdir(parents=True, exist_ok=True)

        moved = []
        for path in file_paths:
            try:
                src = Path(path)
                if not src.exists():
                    continue
                dest = trash_folder / src.name
                counter = 1
                while dest.exists():
                    dest = trash_folder / f"{src.stem}_{counter}{src.suffix}"
                    counter += 1
                shutil.move(str(src), str(dest))
                moved.append({'original': str(src), 'trashed': str(dest)})
            except Exception as e:
                print(f"[FileGuard] Failed to trash {path}: {e}")

        if not moved:
            return None

        manifest = _load_manifest()
        manifest[trash_id] = moved
        _save_manifest(manifest)
        return trash_id

    def undoTrash(self, trash_id):
        manifest = _load_manifest()
        entries = manifest.get(trash_id)
        if not entries:
            return False

        for entry in entries:
            try:
                trashed = Path(entry['trashed'])
                original = Path(entry['original'])
                original.parent.mkdir(parents=True, exist_ok=True)
                if trashed.exists():
                    shutil.move(str(trashed), str(original))
            except Exception as e:
                print(f"[FileGuard] Failed to restore {entry}: {e}")

        del manifest[trash_id]
        _save_manifest(manifest)

        trash_folder = TRASH_DIR / trash_id
        if trash_folder.exists() and not any(trash_folder.iterdir()):
            trash_folder.rmdir()

        return True


def main():
    api = FileGuardAPI()
    dist_index = Path(__file__).parent / 'dist' / 'index.html'
    url = str(dist_index) if dist_index.exists() else 'http://localhost:3000'
    webview.create_window('FileGuard', url, js_api=api, width=430, height=830, resizable=True)
    webview.start()


if __name__ == '__main__':
    main()
