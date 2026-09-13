import os
import hashlib
from pathlib import Path
from datetime import datetime

MEDIA_EXT = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg',
             '.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.flac'}
DOC_EXT = {'.pdf', '.doc', '.docx', '.txt', '.xls', '.xlsx',
           '.ppt', '.pptx', '.csv', '.md', '.rtf'}
ARCHIVE_EXT = {'.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'}

SENSITIVE_NAMES = {'.env', 'id_rsa', 'id_dsa', 'credentials.json',
                    'passwords.txt', 'secrets.yaml', 'secrets.yml'}
SENSITIVE_EXT = {'.pem', '.key', '.pfx', '.p12'}

IGNORED_DIRS = {'.git', 'node_modules', '__pycache__', '.venv', 'venv'}

LARGE_FILE_THRESHOLD = 100 * 1024 * 1024  # 100 MB
OLD_FILE_SECONDS = 180 * 86400            # 180 days


def human_size(num_bytes: float) -> str:
    if num_bytes <= 0:
        return "0 MB"
    if num_bytes >= 1024 ** 3:
        return f"{num_bytes / 1024 ** 3:.2f} GB"
    if num_bytes >= 1024 ** 2:
        return f"{num_bytes / 1024 ** 2:.1f} MB"
    if num_bytes >= 1024:
        return f"{num_bytes / 1024:.1f} KB"
    return f"{int(num_bytes)} B"


def hash_file(path: str, chunk_size: int = 1024 * 1024):
    h = hashlib.md5()
    try:
        with open(path, 'rb') as f:
            while True:
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except (OSError, PermissionError):
        return None


def _to_item(f: dict, badge):
    return {
        'id': f['path'],
        'name': f['name'],
        'path': f['path'],
        'sizeBytes': f['size'],
        'sizeFormatted': human_size(f['size']),
        'badge': badge,
    }


def scan_folder(root_folder: str, options: dict) -> dict:
    root = Path(root_folder)
    all_files = []
    dist_bytes = {'media': 0, 'docs': 0, 'archives': 0}
    scanned = 0

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS]
        for name in filenames:
            fpath = Path(dirpath) / name
            try:
                stat = fpath.stat()
            except (OSError, PermissionError):
                continue
            scanned += 1
            ext = fpath.suffix.lower()
            size = stat.st_size

            if ext in MEDIA_EXT:
                dist_bytes['media'] += size
            elif ext in DOC_EXT:
                dist_bytes['docs'] += size
            elif ext in ARCHIVE_EXT:
                dist_bytes['archives'] += size

            all_files.append({
                'path': str(fpath), 'name': name, 'ext': ext,
                'size': size, 'mtime': stat.st_mtime,
            })

    groups = []
    recoverable_bytes = 0

    # ---------------- Duplicates (by size, then content hash) ----------------
    if options.get('duplicates', True):
        by_size = {}
        for f in all_files:
            if f['size'] > 0:
                by_size.setdefault(f['size'], []).append(f)

        by_hash = {}
        for same_size_files in by_size.values():
            if len(same_size_files) < 2:
                continue
            for f in same_size_files:
                h = hash_file(f['path'])
                if h:
                    by_hash.setdefault((h, f['size']), []).append(f)

        gid = 0
        for (_, size), files in by_hash.items():
            if len(files) < 2:
                continue
            gid += 1
            files_sorted = sorted(files, key=lambda x: x['mtime'])
            items = []
            for idx, f in enumerate(files_sorted):
                badge = 'original' if idx == 0 else 'recommended'
                if idx > 0:
                    recoverable_bytes += f['size']
                items.append(_to_item(f, badge))
            groups.append({
                'id': f'dup-{gid}',
                'titleAr': f'ملفات مكررة ({len(files_sorted)})',
                'titleEn': f'Duplicate Files ({len(files_sorted)})',
                'size': human_size(size * (len(files_sorted) - 1)),
                'items': items,
            })

    # ---------------- Large files ----------------
    if options.get('largeFiles', True):
        large = [f for f in all_files if f['size'] >= LARGE_FILE_THRESHOLD]
        if large:
            large.sort(key=lambda x: -x['size'])
            recoverable_bytes += sum(f['size'] for f in large)
            groups.append({
                'id': 'large-files',
                'titleAr': f'ملفات كبيرة ({len(large)})',
                'titleEn': f'Large Files ({len(large)})',
                'size': human_size(sum(f['size'] for f in large)),
                'items': [_to_item(f, 'recommended') for f in large],
            })

    # ---------------- Old files ----------------
    if options.get('oldFiles', True):
        cutoff = datetime.now().timestamp() - OLD_FILE_SECONDS
        old = [f for f in all_files if f['mtime'] < cutoff]
        if old:
            old.sort(key=lambda x: x['mtime'])
            groups.append({
                'id': 'old-files',
                'titleAr': f'ملفات قديمة ({len(old)})',
                'titleEn': f'Old Files ({len(old)})',
                'size': human_size(sum(f['size'] for f in old)),
                'items': [_to_item(f, 'recommended') for f in old],
            })

    # ---------------- Sensitive files ----------------
    if options.get('sensitiveFiles', False):
        sensitive = [f for f in all_files
                     if f['ext'] in SENSITIVE_EXT or f['name'].lower() in SENSITIVE_NAMES]
        if sensitive:
            groups.append({
                'id': 'sensitive-files',
                'titleAr': f'ملفات حساسة ({len(sensitive)})',
                'titleEn': f'Sensitive Files ({len(sensitive)})',
                'size': human_size(sum(f['size'] for f in sensitive)),
                'items': [_to_item(f, None) for f in sensitive],
            })

    issues_count = sum(len(g['items']) for g in groups)

    return {
        'id': f'scan_{int(datetime.now().timestamp() * 1000)}',
        'folder': str(root),
        'timestamp': datetime.now().isoformat(),
        'stats': {
            'scanned': scanned,
            'issues': issues_count,
            'recoverable': human_size(recoverable_bytes),
        },
        'distribution': {
            'media': human_size(dist_bytes['media']),
            'docs': human_size(dist_bytes['docs']),
            'archives': human_size(dist_bytes['archives']),
        },
        'groups': groups,
    }
