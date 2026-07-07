#!/usr/bin/env python3
# Magnet OS — deploy the static app + /api functions to Vercel via the REST API.
# The Vercel CLI/node isn't always available; this only needs a token + stdlib.
#
#   VERCEL_TOKEN=xxx  python3 tools/deploy-vercel.py            # deploy to project "magnet-op"
#   VERCEL_TOKEN=xxx VERCEL_PROJECT=magnet-op VERCEL_TEAM=magnetaitool-archs-projects \
#     python3 tools/deploy-vercel.py --prod
#
# It uploads index.html, magnetrun.html, the icons/manifest/sw, vercel.json, and the
# api/ functions (skips tools, netlify, supabase, backups, docs — see SKIP below).
# Prints the deployment URL. Nothing is faked: without a real token it exits non-zero.
import os, sys, json, hashlib, urllib.request, urllib.error

TOKEN = os.environ.get('VERCEL_TOKEN')
PROJECT = os.environ.get('VERCEL_PROJECT', 'magnet-op')
TEAM = os.environ.get('VERCEL_TEAM', 'magnetaitool-archs-projects')
PROD = '--prod' in sys.argv
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if not TOKEN:
    print('ERROR: set VERCEL_TOKEN (Vercel → Account Settings → Tokens). Nothing deployed.')
    sys.exit(1)

SKIP_DIRS = {'.git', 'backups', 'node_modules', 'tools', 'netlify', 'supabase', '.vercel'}
SKIP_EXT = {'.md', '.sql', '.toml', '.py'}
SKIP_FILES = {'.env', '.env.local', '.gitignore', '.vercelignore', '_redirects', 'package.json'}

def collect():
    files = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fn), ROOT)
            top = rel.split(os.sep)[0]
            if top in SKIP_DIRS: continue
            if rel in SKIP_FILES: continue
            if os.path.splitext(fn)[1] in SKIP_EXT: continue
            # keep api/*.js even though we skip other .js? we keep all js except in skip dirs
            with open(os.path.join(dirpath, fn), 'rb') as f:
                data = f.read()
            files.append({'file': rel.replace(os.sep, '/'), 'data': data,
                          'sha': hashlib.sha1(data).hexdigest(), 'size': len(data)})
    return files

def api(method, path, body=None, raw=None, ctype='application/json', digest=None):
    url = 'https://api.vercel.com' + path + (('&' if '?' in path else '?') + 'teamId=' + TEAM if TEAM else '')
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + TOKEN)
    req.add_header('Content-Type', ctype)
    if digest: req.add_header('x-vercel-digest', digest)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or '{}')
    except urllib.error.HTTPError as e:
        print('HTTP', e.code, e.read().decode()[:500]); raise

def main():
    files = collect()
    print(f'Uploading {len(files)} files to Vercel project "{PROJECT}"…')
    for fobj in files:
        api('POST', '/v2/files', raw=fobj['data'], ctype='application/octet-stream', digest=fobj['sha'])
    payload = {
        'name': PROJECT,
        'project': PROJECT,
        'target': 'production' if PROD else 'staging',
        'files': [{'file': f['file'], 'sha': f['sha'], 'size': f['size']} for f in files],
        'projectSettings': {'framework': None, 'buildCommand': None, 'outputDirectory': None, 'installCommand': None},
    }
    dep = api('POST', '/v13/deployments', body=payload)
    url = dep.get('url') or (dep.get('alias') or [None])[0]
    print('Deployment created:', 'https://' + url if url else json.dumps(dep)[:400])
    print('State:', dep.get('readyState') or dep.get('status'))
    print('Track it in the Vercel dashboard; production alias updates when the build is READY.')

if __name__ == '__main__':
    main()
