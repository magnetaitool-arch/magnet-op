#!/usr/bin/env python3
"""Static security verification for Magnet OS — runs with plain Python 3.

Why this exists: tools/security-test.js and tools/smoke-test.js are Node scripts,
and Node is not installed on every machine that needs to check this repo. This
script asserts the same security *properties* by reading the source, so the
hardening can be verified anywhere. It sends nothing and changes nothing.

    python3 tools/verify-security.py

Exit code 0 = all checks passed, 1 = at least one failed.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
passed, failed, warned = [], [], []


def read(rel):
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf8", errors="ignore") as fh:
        return fh.read()


def check(name, condition, detail=""):
    (passed if condition else failed).append((name, detail))


def warn(name, detail=""):
    warned.append((name, detail))


# ---------------------------------------------------------------- credentials
app = read("index.html") or ""
check("No built-in owner/admin123 default account",
      "admin123" not in app and "'owner@tiaos.local'" not in app,
      "a shipped default Owner would be guessable by anyone")
check("First Owner requires a setup secret",
      "bootstrapSecret" in app and "setup-required" in (read("supabase/functions/accounts/index.ts") or ""),
      "empty accounts table must not hand the first visitor an Owner account")
check("Password policy is 10+ upper/lower/digit (client)",
      bool(re.search(r"pw\.length<10", app)) and "[A-Z]" in app and r"\d" in app)
edge = read("supabase/functions/accounts/index.ts") or ""
check("Password policy enforced server-side too",
      "next.length<10" in edge,
      "a client-side-only policy is bypassable with curl")
check("Production login has no local password fallback",
      "isLegacyAuthFallbackAllowed" in app
      and bool(re.search(r"if\(!isLegacyAuthFallbackAllowed\(\)\) return \{ ok:false, reason:'unavailable' \}", app)),
      "browser-side hash checking must never be the production auth path")

# ---------------------------------------------------------------- email relay / delivery outbox
outbox = read("server/outbox.js") or ""
check("Email: no wildcard *.vercel.app origin",
      "vercel\\.app$" not in outbox and "(^|\\.)vercel" not in outbox,
      "any other Vercel project could otherwise relay mail through this key")
check("Email: origin-less browser requests are not auto-trusted",
      "authenticated_session_required" in outbox and "worker_secret_required" in outbox)
check("Email: payload is validated",
      "validEmailPayload" in outbox and "emailArray" in outbox,
      "recipient/subject/body validation blocks header injection and abuse")
check("Email: subject rejects CR/LF (header injection)",
      bool(re.search(r"\[\\r\\n\]", outbox)))
check("Email: provider work is durable and server-side",
      "claim_outbox_messages" in outbox and "finish_outbox_message" in outbox and "RESEND_API_KEY" in outbox)
for label, rel in (("Vercel", "api/send-email.js"), ("Netlify", "netlify/functions/send-email.js")):
    src = read(rel)
    if src is None:
        warn(f"{label} email endpoint missing", rel)
        continue
    check(f"{label}: uses the shared authorized outbox", "handleOutbox" in src)

# ---------------------------------------------------------------- secrets
SECRET_PAT = re.compile(r"service_role|SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['\"]|re_[A-Za-z0-9]{20,}|vcp_[A-Za-z0-9]{20,}")
for rel in ("index.html", "serviceworker.js", "manifest.json"):
    src = read(rel)
    if src is None:
        continue
    check(f"No server secret shipped in {rel}", not SECRET_PAT.search(src))

# ---------------------------------------------------------------- headers/CSP
vercel = read("vercel.json") or ""
for header in ("Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy",
               "Strict-Transport-Security", "X-Frame-Options", "Permissions-Policy"):
    check(f"vercel.json sets {header}", header in vercel)
check("CSP restricts object-src and base-uri",
      "object-src 'none'" in vercel and "base-uri 'self'" in vercel)
if "'unsafe-inline'" in vercel:
    warn("CSP still allows 'unsafe-inline' for scripts",
         "required by the single-file Babel/htm architecture; revisit if the app is ever bundled")

# ---------------------------------------------------------------- env docs
env = read(".env.example") or ""
for key in ("INITIAL_OWNER_SETUP_SECRET", "EMAIL_SHARED_SECRET", "RESEND_API_KEY"):
    check(f".env.example documents {key}", key in env)

# ---------------------------------------------------------------- report
print("\nMagnet OS — static security verification\n" + "=" * 44)
for name, _ in passed:
    print("  PASS  " + name)
for name, detail in failed:
    print("  FAIL  " + name + (("  <- " + detail) if detail else ""))
for name, detail in warned:
    print("  WARN  " + name + (("  <- " + detail) if detail else ""))
print("=" * 44)
print(f"{len(passed)} passed, {len(failed)} failed, {len(warned)} warnings")
print("\nNOT covered here (needs a running deployment):")
print("  - live RLS behaviour, anon-policy removal, JWT rollout")
print("  - real HTTP responses from the email endpoints (see tools/security-test.js, needs Node)")
sys.exit(1 if failed else 0)
