"""
test_glance_refresh.py

Core Gap Closure 5: Glance must reflect current server state after any
mutation that actually changes Glance-derived data, on the NEXT fetch.

The refetch itself is a client concern (a monotonic refreshKey the patient
workspace bumps after a server-confirmed relevant mutation, wired only for
comment create / resolve / reopen and Timeline edit / revert). This file
proves the API-level contract that wiring depends on: after each mutation,
a fresh GET /api/patients/:id/glance already returns the correct numbers,
and mutations that are NOT Glance-relevant leave those numbers alone.

Black-box HTTP, temporary Clinician clinician_note fixture on Patient A,
deleted by exact id (fixture entry + its comments + any Version/Audit) in a
finally block via the same throwaway-tsx Prisma script the suite uses.

Covers §33 of the block brief:
  A  baseline Glance openActions known
  B  create unresolved comment  -> next Glance openActions +1
  C  resolve comment            -> next Glance openActions -1
  D  reopen comment             -> next Glance openActions +1
  E  assignment-only PATCH      -> openActions unchanged
  F  Timeline edit (PUT)        -> edited entry is now recentChanges[0] (updatedAt)
  G  stale PUT -> 409           -> no data change
  H  Highlight feedback         -> Glance riskHighlights count / critical / order unchanged
  I  read-only actions          -> no Glance DB state change
  J  same-patient rapid sequence: resolve c1 then assignment-only PATCH c2
     -> final openActions reflects ONLY the resolve

Setup:
  1. npx tsx prisma/seed.ts
  2. dev server running (NIGHTINGALE_BASE_URL, default http://localhost:3000)

Run:
  NIGHTINGALE_BASE_URL=http://localhost:3100 python3 test_glance_refresh.py

Exit code: 0 if all cases pass AND cleanup succeeds, 1 otherwise.
"""

import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

BASE_URL = os.environ.get("NIGHTINGALE_BASE_URL", "http://localhost:3000").rstrip("/")

EMAILS = {
    "clinician_a": "clinician.a@clinic-a.test",
    "staff_a": "staff.a@clinic-a.test",
    "admin_a": "admin.a@clinic-a.test",
    "clinician_b": "clinician.b@clinic-b.test",
    "patient_a": "patient.a@clinic-a.test",
}
PATIENT_A = "synthetic-patient-a"
LEARNING = "synthetic-patient-learning"
USER_STAFF_A = "synthetic-user-staff-a"
USER_CLINICIAN_A = "synthetic-user-clinician-a"
HL_LEARNING_PENDING = "synthetic-highlight-learning-y-g"  # pending, non-critical, safe to toggle+restore

_tok = {}
results = []
created_entry_ids = []


def _http(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{BASE_URL}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, (json.loads(raw) if raw else None)
        except json.JSONDecodeError:
            return e.code, None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Cannot reach {BASE_URL} ({e.reason})") from e


def login(key):
    if key in _tok:
        return _tok[key]
    s, p = _http("POST", "/api/auth/login", body={"email": EMAILS[key]})
    if s != 200 or not isinstance(p, dict) or not p.get("token"):
        raise RuntimeError(f"login failed for {key} ({s})")
    _tok[key] = p["token"]
    return p["token"]


def check(name, cond):
    results.append(bool(cond))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}")


def glance(key, pid):
    return _http("GET", f"/api/patients/{pid}/glance", token=login(key))


def open_actions_count(key, pid):
    s, g = glance(key, pid)
    return len(g["openActions"]) if s == 200 and isinstance(g, dict) else None


CLEANUP_TEMPLATE = """\
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "__PRISMA_CLIENT_IMPORT__";
const entryIds = __ENTRY_IDS_JSON__;
async function main() {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    if (entryIds.length === 0) { console.log(JSON.stringify({ ok: true, deleted: 0 })); return; }
    const c = await prisma.comment.deleteMany({ where: { timelineEntryId: { in: entryIds } } });
    const a = await prisma.auditEvent.deleteMany({ where: { timelineEntryId: { in: entryIds } } });
    const v = await prisma.version.deleteMany({ where: { timelineEntryId: { in: entryIds } } });
    const e = await prisma.timelineEntry.deleteMany({ where: { id: { in: entryIds } } });
    console.log(JSON.stringify({ ok: true, comments: c.count, audits: a.count, versions: v.count, entries: e.count }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(JSON.stringify({ ok: false, code: e && e.code })); process.exit(1); });
"""

PROBE_TEMPLATE = """\
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "__PRISMA_CLIENT_IMPORT__";
async function main() {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    console.log(JSON.stringify({ ok: true,
      comments: await prisma.comment.count(),
      versions: await prisma.version.count(),
      audits: await prisma.auditEvent.count(),
      sysEvents: await prisma.timelineEntry.count({ where: { type: "system_event" } }),
      unresolvedPatA: await prisma.comment.count({ where: { resolved: false, timelineEntry: { patientId: "synthetic-patient-a" } } }),
    }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(JSON.stringify({ ok: false, code: e && e.code })); process.exit(1); });
"""


def _run_tsx(template, entry_ids, name):
    root = os.path.dirname(os.path.abspath(__file__))
    client_path = os.path.join(root, "src", "generated", "prisma", "client")
    try:
        with tempfile.TemporaryDirectory(prefix="nightingale-glance-refresh-") as tmp:
            rel = os.path.relpath(os.path.realpath(client_path), start=os.path.realpath(tmp)).replace(os.sep, "/")
            if not rel.startswith("."):
                rel = "./" + rel
            script = template.replace("__PRISMA_CLIENT_IMPORT__", rel).replace("__ENTRY_IDS_JSON__", json.dumps(entry_ids))
            path = os.path.join(tmp, name)
            with open(path, "w", encoding="utf-8") as f:
                f.write(script)
            env = {**os.environ, "NODE_PATH": os.path.join(root, "node_modules")}
            proc = subprocess.run(["npx", "tsx", path], cwd=root, capture_output=True, text=True, timeout=60, env=env)
    except (subprocess.TimeoutExpired, OSError) as e:
        return None, f"subprocess failed: {type(e).__name__}"
    lines = (proc.stdout or "").strip().splitlines()
    try:
        payload = json.loads(lines[-1]) if lines else None
    except json.JSONDecodeError:
        payload = None
    if proc.returncode != 0 or not isinstance(payload, dict) or not payload.get("ok"):
        return None, f"script exited {proc.returncode}"
    return payload, None


def run():
    print(f"Target: {BASE_URL}\n")
    ca = "clinician_a"

    # ─── A  baseline ────────────────────────────────────────────────
    base = open_actions_count(ca, PATIENT_A)
    check("A. baseline Glance openActions for Patient A is known (canonical 2)", base == 2)

    # temp fixture entry on Patient A
    s, created = _http("POST", "/api/timeline", token=login(ca),
                       body={"content": "Glance-refresh fixture note.", "patientId": PATIENT_A,
                             "type": "clinician_note", "sectionKey": "summary"})
    entry_id = created.get("id") if isinstance(created, dict) else None
    if entry_id:
        created_entry_ids.append(entry_id)
    check("F0. fixture entry created (v1)", s == 201 and created.get("versionNumber") == 1)
    if not entry_id:
        return

    probe_before, _ = _run_tsx(PROBE_TEMPLATE, [], "p.ts")

    # ─── B  create unresolved comment -> +1 ────────────────────────
    s, c1 = _http("POST", f"/api/timeline/{entry_id}/comments", token=login(ca), body={"content": "First open item."})
    c1id = c1.get("id") if isinstance(c1, dict) else None
    check("B. create unresolved comment -> 201; next Glance openActions == base+1",
          s == 201 and open_actions_count(ca, PATIENT_A) == base + 1)

    # ─── C  resolve -> -1 ─────────────────────────────────────────
    s, _ = _http("PATCH", f"/api/comments/{c1id}", token=login(ca), body={"resolved": True})
    check("C. resolve comment -> 200; next Glance openActions back to base",
          s == 200 and open_actions_count(ca, PATIENT_A) == base)

    # ─── D  reopen -> +1 ─────────────────────────────────────────
    s, _ = _http("PATCH", f"/api/comments/{c1id}", token=login(ca), body={"resolved": False})
    check("D. reopen comment -> 200; next Glance openActions == base+1",
          s == 200 and open_actions_count(ca, PATIENT_A) == base + 1)

    # ─── E  assignment-only -> unchanged ─────────────────────────
    s, _ = _http("PATCH", f"/api/comments/{c1id}", token=login(ca), body={"assignedToId": USER_STAFF_A})
    after_assign = open_actions_count(ca, PATIENT_A)
    check("E. assignment-only PATCH -> 200; Glance openActions UNCHANGED (still base+1)",
          s == 200 and after_assign == base + 1)
    s, _ = _http("PATCH", f"/api/comments/{c1id}", token=login(ca), body={"assignedToId": None})
    check("E2. clear assignment -> 200; openActions still base+1",
          s == 200 and open_actions_count(ca, PATIENT_A) == base + 1)

    # ─── F  Timeline edit moves entry to top of recentChanges ────
    s, put = _http("PUT", f"/api/timeline/{entry_id}", token=login(ca),
                   body={"content": "Glance-refresh fixture note (edited).", "expectedVersion": 1})
    check("F1. Timeline edit (expectedVersion 1) -> 200, versionNumber 2", s == 200 and put.get("versionNumber") == 2)
    s, g = glance(ca, PATIENT_A)
    rc = g.get("recentChanges", []) if isinstance(g, dict) else []
    check("F2. edited entry is now recentChanges[0] (ordered by updatedAt DESC)",
          s == 200 and len(rc) >= 1 and rc[0]["entryId"] == entry_id)
    check("F3. recentChanges still capped at 5 and excludes system_event",
          len(rc) <= 5 and all(r["type"] != "system_event" for r in rc))

    # ─── G  stale PUT -> 409, no change ─────────────────────────
    oa_before_stale = open_actions_count(ca, PATIENT_A)
    s, _ = _http("PUT", f"/api/timeline/{entry_id}", token=login(ca),
                 body={"content": "should not apply", "expectedVersion": 1})
    check("G. stale PUT -> 409; Glance openActions unchanged by the failed write",
          s == 409 and open_actions_count(ca, PATIENT_A) == oa_before_stale)

    # ─── H  Highlight feedback does not change what Glance returns for the panel ──
    s, g0 = glance(ca, LEARNING)
    rh0 = g0["riskHighlights"]
    crit0 = [h for h in rh0 if h["riskFloor"] == "critical"]
    s, _ = _http("PATCH", f"/api/highlights/{HL_LEARNING_PENDING}", token=login(ca), body={"feedback": "accepted"})
    check("H0. Highlight feedback PATCH -> 200", s == 200)
    s, g1 = glance(ca, LEARNING)
    rh1 = g1["riskHighlights"]
    crit1 = [h for h in rh1 if h["riskFloor"] == "critical"]
    check(
        "H1. Glance riskHighlights count, critical count, first-critical id, and "
        "row order are ALL unchanged by feedback (feedback is not a Glance input)",
        len(rh1) == len(rh0)
        and len(crit1) == len(crit0) == 1
        and crit1[0]["id"] == crit0[0]["id"]
        and [h["id"] for h in rh1] == [h["id"] for h in rh0],
    )
    # NOTE: PATCH /api/highlights/:id only accepts accepted|rejected, never
    # pending, so HL_LEARNING_PENDING cannot be reset here. The caller MUST
    # run `npx tsx prisma/seed.ts` afterward to restore the seeded feedback
    # state / adaptive baseline (same convention as
    # test_adaptive_highlight_priority.py).

    # ─── J  same-patient rapid sequence ────────────────────────
    # two open comments now: create a second one, then resolve #1 and
    # immediately do an assignment-only PATCH on #2.
    s, c2 = _http("POST", f"/api/timeline/{entry_id}/comments", token=login(ca), body={"content": "Second open item."})
    c2id = c2.get("id") if isinstance(c2, dict) else None
    oa_pre = open_actions_count(ca, PATIENT_A)  # base + 2 (c1 reopened earlier + c2)
    s1, _ = _http("PATCH", f"/api/comments/{c1id}", token=login(ca), body={"resolved": True})
    s2, _ = _http("PATCH", f"/api/comments/{c2id}", token=login(ca), body={"assignedToId": USER_CLINICIAN_A})
    oa_post = open_actions_count(ca, PATIENT_A)
    check(
        "J. resolve(c1) + assignment-only(c2): both 200; final openActions == "
        "pre - 1 (only the resolve counted; the assignment did not)",
        s1 == 200 and s2 == 200 and oa_pre is not None and oa_post == oa_pre - 1,
    )

    # ─── I  read-only actions do not mutate Glance DB state ────
    probe_mid, _ = _run_tsx(PROBE_TEMPLATE, [], "p.ts")
    for _ in range(3):
        glance(ca, PATIENT_A)
        glance(ca, LEARNING)
        _http("GET", f"/api/patients/{LEARNING}/highlights", token=login(ca))
        _http("GET", f"/api/timeline/{entry_id}", token=login(ca))
        _http("GET", f"/api/timeline/{entry_id}/versions", token=login(ca))
    probe_after_reads, _ = _run_tsx(PROBE_TEMPLATE, [], "p.ts")
    check("I. a batch of read-only GETs (glance/highlights/timeline/versions) mutated nothing",
          probe_mid is not None and probe_after_reads is not None and probe_mid == probe_after_reads)


if __name__ == "__main__":
    try:
        run()
    except Exception as e:  # noqa: BLE001
        print(f"ERROR during test run: {type(e).__name__}: {e}")
        results.append(False)
    finally:
        print("\n-- Cleanup --")
        if not created_entry_ids:
            print("(nothing to clean up)")
        else:
            payload, err = _run_tsx(CLEANUP_TEMPLATE, created_entry_ids, "cleanup.ts")
            check("cleanup. fixture entry + comments + version/audit deleted by exact id",
                  payload is not None and payload.get("ok"))
            print(f"   {json.dumps(payload) if payload else err}")

    total = len(results)
    passed = sum(1 for r in results if r)
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if passed == total else 1)
