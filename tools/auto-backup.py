#!/usr/bin/env python3
"""Magnet OS — daily cloud backup (no dependencies).

Dumps every row of the Supabase `records` table (paginated past the 1000-row
cap) into backups/auto/backup-YYYY-MM-DD.json and keeps the newest 30 files.
Installed as a launchd agent (com.magnetos.backup) — runs daily at 15:00.
To remove: launchctl unload ~/Library/LaunchAgents/com.magnetos.backup.plist
           && rm ~/Library/LaunchAgents/com.magnetos.backup.plist
"""
import json, os, urllib.request, datetime, glob

URL = "https://jdylrthffifbhyrrhuqd.supabase.co/rest/v1/records?select=id,coll,data&order=id.asc"
KEY = "sb_publishable_6Qe2KdPIZ13Ij2wvkS12rA_k2ytZQLz"  # public anon key (same one the app ships)
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
