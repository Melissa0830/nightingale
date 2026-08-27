"""
test_learning_patient_workflow.py

Block 8 smoke test: the promoted `synthetic-patient-learning` (Clinic A) is a
complete patient case that runs on the SAME infrastructure as Patient A —
RBAC, edit/OCC/revert, Clinician override, provenance — and none of the
Block 8 additions moved any Self-Learning v2 number.

Mutating sections (edit/OCC/revert, one override PUT) are PATCH/revert-safe
where possible; the caller MUST run `npx tsx prisma/seed.ts` afterward to
restore canonical entry content/versionNumber. Any override system_event
rows this run creates are deleted by exact id in a `finally` block via the
same throwaway-Prisma-script mechanism the other suites use (no DELETE
endpoint exists in the API).

Setup:
  1. npx tsx prisma/seed.ts
  2. dev server running (NIGHTINGALE_BASE_URL, default http://localhost:3000)

Run:
  NIGHTINGALE_BASE_URL=http://localhost:3100 python3 test_learning_patient_workflow.py

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
}
LEARNING = "synthetic-patient-learning"
LEARNING_B = "synthetic-patient-learning-b"
PLAN_ENTRY = "synthetic-entry-learning-plan"
AI_DOCTOR_ENTRY = "synthetic-entry-learning-ai-doctor"
AI_NURSE_ENTRY = "synthetic-entry-learning-ai-nurse"
AI_PATIENT_ENTRY = "synthetic-entry-learning-ai-patient"

_tok = {}
results = []
created_system_events = set()


def http(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
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
    s, p = http("POST", "/api/auth/login", body={"email": EMAILS[key]})
    if s != 200 or not isinstance(p, dict) or not p.get("token"):
        raise RuntimeError(f"login failed for {key} ({s})")
    _tok[key] = p["token"]
    return p["token"]


def check(name, cond):
    results.append(bool(cond))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}")


def sysevent_ids(pid):
    s, p = http("GET", f"/api/patients/{pid}/timeline", token=login("clinician_a"))
    if s != 200 or not isinstance(p, list):
        return set()
    return {e["id"] for e in p if e.get("type") == "system_event"}


CLEANUP_TEMPLATE = """\
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "__PRISMA_CLIENT_IMPORT__";
const ids = __IDS_JSON__;
async function main() {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    if (ids.length === 0) { console.log(JSON.stringify({ ok: true, deleted: 0 })); return; }
    const a = await prisma.auditEvent.deleteMany({ where: { timelineEntryId: { in: ids } } });
    const e = await prisma.timelineEntry.deleteMany({ where: { id: { in: ids }, type: "system_event" } });
    console.log(JSON.stringify({ ok: true, deletedAudits: a.count, deleted: e.count }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(JSON.stringify({ ok: false, code: e && e.code })); process.exit(1); });
"""


def cleanup_system_events(ids):
    root = os.path.dirname(os.path.abspath(__file__))
    client_path = os.path.join(root, "src", "generated", "prisma", "client")
    with tempfile.TemporaryDirectory(prefix="nightingale-learn-cleanup-") as tmp:
        rel = os.path.relpath(os.path.realpath(client_path), start=os.path.realpath(tmp))
        script = CLEANUP_TEMPLATE.replace("__PRISMA_CLIENT_IMPORT__", rel.replace(os.sep, "/"))
        script = script.replace("__IDS_JSON__", json.dumps(sorted(ids)))
        path = os.path.join(tmp, "cleanup.ts")
        with open(path, "w") as f:
            f.write(script)
        env = dict(os.environ)
        env["NODE_PATH"] = os.path.join(root, "node_modules")
        try:
            proc = subprocess.run(
                ["npx", "tsx", path], cwd=root, env=env, capture_output=True, text=True, timeout=120
            )
        except (subprocess.TimeoutExpired, OSError) as e:
            return False, f"{type(e).__name__}"
        line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            return False, "unparseable cleanup output"
        return bool(payload.get("ok")), payload


def run_tests():
    print(f"Target: {BASE_URL}\n")

    # ─── §25 RBAC smoke ─────────────────────────────────────────────────
    print("-- RBAC smoke --")
    ca = login("clinician_a")
    check("R1. Clinician A GET learning patient -> 200",
          http("GET", f"/api/patients/{LEARNING}", token=ca)[0] == 200)
    check("R2. Clinician A GET learning timeline -> 200",
          http("GET", f"/api/patients/{LEARNING}/timeline", token=ca)[0] == 200)
    check("R3. Clinician A GET learning highlights -> 200",
          http("GET", f"/api/patients/{LEARNING}/highlights", token=ca)[0] == 200)
    check("R4. Clinician A GET learning glance -> 200",
          http("GET", f"/api/patients/{LEARNING}/glance", token=ca)[0] == 200)

    cb = login("clinician_b")
    check("R5. Clinician B (Clinic B) GET learning patient -> 403",
          http("GET", f"/api/patients/{LEARNING}", token=cb)[0] == 403)
    check("R6. Clinician B GET learning timeline -> 403",
          http("GET", f"/api/patients/{LEARNING}/timeline", token=cb)[0] == 403)
    check("R7. Clinician B GET learning highlights -> 403",
          http("GET", f"/api/patients/{LEARNING}/highlights", token=cb)[0] == 403)

    sa = login("staff_a")
    check("R8. Staff A (same clinic) GET learning timeline -> 200",
          http("GET", f"/api/patients/{LEARNING}/timeline", token=sa)[0] == 200)
    aa = login("admin_a")
    check("R9. Admin A (same clinic) GET learning timeline -> 200",
          http("GET", f"/api/patients/{LEARNING}/timeline", token=aa)[0] == 200)
    check("R10. Staff A (same clinic) GET learning glance -> 200 (existing Staff glance rule)",
          http("GET", f"/api/patients/{LEARNING}/glance", token=sa)[0] == 200)

    # ─── §26 edit / OCC / revert smoke on the learning Plan ─────────────
    print("\n-- edit / OCC / revert smoke (synthetic-entry-learning-plan) --")
    # Snapshot system_events BEFORE any mutation: the revert (E6) and the
    # override PUT (O1) each append a system_event that reseed will not clean
    # (new cuid, not in the seed reset list). Everything new gets deleted by
    # exact id in the finally block below.
    system_events_at_start = sysevent_ids(LEARNING)
    s, e0 = http("GET", f"/api/timeline/{PLAN_ENTRY}", token=ca)
    check("E0. plan entry starts at versionNumber 1, sectionKey plan",
          s == 200 and e0.get("versionNumber") == 1 and e0.get("sectionKey") == "plan")
    canonical_content = e0.get("content")

    s, b = http("PUT", f"/api/timeline/{PLAN_ENTRY}", token=ca,
                body={"content": "B8_SMOKE_EDIT_1", "expectedVersion": 1})
    check("E1. normal PUT expectedVersion 1 -> 200, versionNumber 2",
          s == 200 and b.get("versionNumber") == 2)

    s, b = http("PUT", f"/api/timeline/{PLAN_ENTRY}", token=ca,
                body={"content": "B8_SMOKE_EDIT_2", "expectedVersion": 2})
    check("E2. competing PUT expectedVersion 2 -> 200, versionNumber 3",
          s == 200 and b.get("versionNumber") == 3)

    s, b = http("PUT", f"/api/timeline/{PLAN_ENTRY}", token=ca,
                body={"content": "B8_SMOKE_STALE", "expectedVersion": 1})
    check("E3. stale PUT expectedVersion 1 -> 409", s == 409)
    s, e_now = http("GET", f"/api/timeline/{PLAN_ENTRY}", token=ca)
    check("E4. stale PUT did not overwrite: content still B8_SMOKE_EDIT_2, versionNumber 3",
          s == 200 and e_now.get("content") == "B8_SMOKE_EDIT_2" and e_now.get("versionNumber") == 3)

    s, v = http("GET", f"/api/timeline/{PLAN_ENTRY}/versions", token=ca)
    hist = v.get("versions") if isinstance(v, dict) else None
    check("E5. versions endpoint returns 2 historical snapshots (v1, v2)",
          s == 200 and isinstance(hist, list) and len(hist) == 2
          and {r["versionNumber"] for r in hist} == {1, 2})

    s, b = http("POST", f"/api/timeline/{PLAN_ENTRY}/revert", token=ca,
                body={"targetVersion": 1, "expectedVersion": 3})
    check("E6. revert to v1 -> 200, content == canonical, versionNumber advances to 4",
          s == 200 and b.get("content") == canonical_content and b.get("versionNumber") == 4)

    # ─── §27 minimal Clinician-override verification (learning AI doctor) ─
    print("\n-- Clinician override smoke (synthetic-entry-learning-ai-doctor) --")
    se_before = sysevent_ids(LEARNING)
    s, ai0 = http("GET", f"/api/timeline/{AI_DOCTOR_ENTRY}", token=ca)
    check("O0. learning AI doctor entry: type ai_doctor_consult_summary, provenance doctor_consult",
          s == 200 and ai0.get("type") == "ai_doctor_consult_summary"
          and ai0.get("provenanceType") == "doctor_consult"
          and ai0.get("provenanceId") == "synthetic-session-learning-consult-001")
    s, b = http("PUT", f"/api/timeline/{AI_DOCTOR_ENTRY}", token=ca,
                body={"content": "B8_OVERRIDE_EDIT", "expectedVersion": 1})
    check("O1. Clinician PUT on AI-scribed entry (override path) -> 200, versionNumber 2",
          s == 200 and b.get("versionNumber") == 2)
    s, ai1 = http("GET", f"/api/timeline/{AI_DOCTOR_ENTRY}", token=ca)
    check("O2. provenance unchanged after override edit",
          s == 200 and ai1.get("provenanceType") == "doctor_consult"
          and ai1.get("provenanceId") == "synthetic-session-learning-consult-001")
    se_after = sysevent_ids(LEARNING)
    new_se = se_after - se_before
    check("O3. override produced exactly one new system_event on the learning patient",
          len(new_se) == 1)
    # Register EVERY system_event created since the mutating section started
    # (revert from E6 + override from O1) for exact-id cleanup.
    for sid in sysevent_ids(LEARNING) - system_events_at_start:
        created_system_events.add(sid)

    # ─── §45 collision + adaptive non-regression (read-only) ────────────
    print("\n-- adaptive non-regression (Block 8 Core entries carry no Highlights) --")
    s, hl = http("GET", f"/api/patients/{LEARNING}/highlights", token=ca)
    by = {h["id"]: h for h in hl} if isinstance(hl, list) else {}

    def adj(hid):
        return by.get(hid, {}).get("learnedAdjustment")

    check("A1. positive bucket target still 3/0/+2",
          by.get("synthetic-highlight-learning-x-d", {}).get("acceptedCount") == 3
          and by.get("synthetic-highlight-learning-x-d", {}).get("rejectedCount") == 0
          and adj("synthetic-highlight-learning-x-d") == 2)
    check("A2. gathering bucket target still 2/0/0",
          by.get("synthetic-highlight-learning-y-g", {}).get("reviewCount") == 2
          and adj("synthetic-highlight-learning-y-g") == 0)
    check("A3. negative bucket target still 0/3/-2",
          by.get("synthetic-highlight-learning-z-d", {}).get("rejectedCount") == 3
          and adj("synthetic-highlight-learning-z-d") == -2)
    lex = by.get("synthetic-highlight-learning-x-lex", {})
    check("A4. lexical target: method lexical, same representative, ~0.833",
          lex.get("matchMethod") == "lexical"
          and lex.get("matchedBucketRepresentativeId") == "synthetic-highlight-learning-x-a"
          and abs((lex.get("lexicalOverlapScore") or 0) - 0.8333333333333334) < 1e-9)
    crit = by.get("synthetic-highlight-learning-critical", {})
    check("A5. critical fixture: riskFloor critical, adjustment 0, method none",
          crit.get("riskFloor") == "critical" and crit.get("learnedAdjustment") == 0
          and crit.get("matchMethod") == "none")
    crit_count = len([h for h in hl if h.get("riskFloor") == "critical"])
    check("A6. exactly ONE critical highlight for the learning patient (unchanged)", crit_count == 1)

    # ─── §41 provenance non-regression for all three AI types ───────────
    print("\n-- AI Scribe provenance (all three types) --")
    prov = {}
    for eid in (AI_NURSE_ENTRY, AI_PATIENT_ENTRY):
        s, e = http("GET", f"/api/timeline/{eid}", token=ca)
        prov[eid] = (e.get("type"), e.get("provenanceType"), e.get("provenanceId")) if s == 200 else None
    check("P1. AI nurse entry: ai_nurse_consult_summary / nurse_consult / synthetic-session-learning-nurse-001",
          prov[AI_NURSE_ENTRY] == ("ai_nurse_consult_summary", "nurse_consult", "synthetic-session-learning-nurse-001"))
    check("P2. AI patient-session entry: ai_patient_session_summary / patient_session / synthetic-session-learning-session-001",
          prov[AI_PATIENT_ENTRY] == ("ai_patient_session_summary", "patient_session", "synthetic-session-learning-session-001"))

    # ─── Clinic isolation still holds ──────────────────────────────────
    s, lb = http("GET", f"/api/patients/{LEARNING_B}/highlights", token=cb)
    check("I1. Clinic B control unchanged: all learnedAdjustment == -2",
          s == 200 and isinstance(lb, list) and {h["learnedAdjustment"] for h in lb} == {-2})


if __name__ == "__main__":
    cleanup_ok, cleanup_info = True, None
    try:
        run_tests()
    finally:
        cleanup_ok, cleanup_info = cleanup_system_events(created_system_events)

    print("\n-- cleanup --")
    check("cleanup. override system_event rows removed by exact id", cleanup_ok)
    print(f"cleanup: {cleanup_info}")
    print(
        "\nNOTE: this run edited synthetic-entry-learning-plan and "
        "synthetic-entry-learning-ai-doctor. Run `npx tsx prisma/seed.ts` "
        "afterward to restore canonical content/versionNumber."
    )

    total = len(results)
    passed = sum(results)
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if (passed == total and cleanup_ok) else 1)
