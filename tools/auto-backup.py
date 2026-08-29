#!/usr/bin/env python3
"""Magnet OS — daily cloud backup (no dependencies).

Dumps every row of the Supabase `records` table (paginated past the 1000-row
cap) into backups/auto/backup-YYYY-MM-DD.json and keeps the newest 30 files.
Installed as a launchd agent (com.magnetos.backup) — runs daily at 15:00.
To remove: launchctl unload ~/Library/LaunchAgents/com.magnetos.backup.plist
           && rm ~/Library/LaunchAgents/com.magnetos.backup.plist
"""
import json, os, urllib.request, datetime, glob

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

def load_local_env():
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

load_local_env()
BASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not BASE_URL.startswith("https://") or not KEY:
    raise SystemExit("explicit SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — backup NOT started")
URL = BASE_URL + "/rest/v1/records?select=id,coll,data&order=id.asc"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backups", "auto")
KEEP = 30

def fetch_all():
    rows, start = [], 0
    while True:
        req = urllib.request.Request(URL, headers={
            "apikey": KEY, "Authorization": "Bearer " + KEY,
            "Range": f"{start}-{start+999}", "Range-Unit": "items"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            chunk = json.loads(resp.read().decode())
        rows.extend(chunk)
        if len(chunk) < 1000:
            return rows
        start += 1000

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    rows = fetch_all()
    if not rows:            # never overwrite good backups with an empty dump
        raise SystemExit("empty result — backup NOT written")
    day = datetime.date.today().isoformat()
    path = os.path.join(OUT_DIR, f"backup-{day}.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rows, f, ensure_ascii=False)
    os.replace(tmp, path)
    old = sorted(glob.glob(os.path.join(OUT_DIR, "backup-*.json")))[:-KEEP]
    for p in old:
        os.remove(p)
    print(f"backup ok: {len(rows)} records -> {path}")

if __name__ == "__main__":
    main()
