"""
test_provenance_source.py

Core Gap Closure 4: provenance source jump / exact source context.

The exact-quote locator itself is a pure UI-layer helper, unit-tested in
src/lib/provenance/locate-quote.test.ts. This file proves the API contract
the source-view UI depends on, and that resolving / viewing provenance
mutates nothing.

Read-only. No fixtures created, no cleanup, safe to run any time.

Covers (§35 / §37 of the block brief):
  A  authorized Clinician resolves a Highlight -> its linked source entry
  B  Staff GET highlights + source entry per the existing contract
  C  Admin GET highlights + source entry per the existing contract
  D  Patient cannot retrieve Highlight provenance (403)
  E  cross-clinic caller cannot retrieve the source entry (403)
  F  positive exact-quote case: quotedTextFound true, occurrenceCount 1,
     quotedText is a verbatim substring of entryContent
  G  critical negative case: linked entry exists and is retrievable,
     quotedTextFound false, occurrenceCount 0, riskFloor still critical
  H  AI Scribe provenanceType / provenanceId unchanged and distinct
  I  a batch of provenance GETs mutates nothing (Version / AuditEvent /
     system_event counts, Highlight feedback/importance, entry
     versionNumber/updatedAt all unchanged)
  J  Scenario C: the oldest-group (15 Apr 2025) source entries are still
     individually retrievable by an authorized Clinician

Setup:
  1. npx tsx prisma/seed.ts
  2. dev server running (NIGHTINGALE_BASE_URL, default http://localhost:3000)

Run:
  NIGHTINGALE_BASE_URL=http://localhost:3100 python3 test_provenance_source.py

Exit code: 0 if all cases pass, 1 otherwise.
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
LEARNING = "synthetic-patient-learning"
PATIENT_A = "synthetic-patient-a"

HL_POSITIVE = "synthetic-highlight-learning-x-a"          # found, occ 1
HL_CRITICAL = "synthetic-highlight-learning-critical"     # NOT found, occ 0, critical
HL_AI = "synthetic-highlight-ai-doctor-summary"           # Patient A, AI-doctor entry

ENTRY_FOLLOWUP = "synthetic-entry-learning-followup"      # 2026-02-06
ENTRY_RISKFLAG = "synthetic-entry-learning-riskflag"      # 2026-02-06
ENTRY_AI_DOCTOR_A = "synthetic-entry-ai-doctor-summary"   # Patient A, doctor_consult
OLDEST_GROUP_ENTRIES = [
    "synthetic-entry-learning-patient-summary",           # 2025-04-15T09:00
    "synthetic-entry-learning-staff-note",                # 2025-04-15T09:30
]

_tok = {}
results = []


def _http(method, path, token=None):
    req = urllib.request.Request(f"{BASE_URL}{path}", headers=({"Authorization": f"Bearer {token}"} if token else {}), method=method)
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
    import urllib.request as u
    req = u.Request(f"{BASE_URL}/api/auth/login", data=json.dumps({"email": EMAILS[key]}).encode(),
                    headers={"Content-Type": "application/json"}, method="POST")
    with u.urlopen(req) as r:
        _tok[key] = json.load(r)["token"]
    return _tok[key]


def check(name, cond):
    results.append(bool(cond))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}")


def highlights(key, pid):
    return _http("GET", f"/api/patients/{pid}/highlights", token=login(key))


def entry(key, eid):
    return _http("GET", f"/api/timeline/{eid}", token=login(key))


def find(rows, hid):
    return next((h for h in rows if isinstance(h, dict) and h.get("id") == hid), None) if isinstance(rows, list) else None


PROBE_TEMPLATE = """\
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "__PRISMA_CLIENT_IMPORT__";
async function main() {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const versions = await prisma.version.count();
    const audits = await prisma.auditEvent.count();
    const sysEvents = await prisma.timelineEntry.count({ where: { type: "system_event" } });
    const hl = await prisma.highlight.findMany({ where: { id: { in: __ENTRY_IDS_JSON__ } }, select: { id: true, feedback: true, importance: true, quotedText: true, entryId: true } });
    const ent = await prisma.timelineEntry.findMany({ where: { id: { in: ["synthetic-entry-learning-riskflag", "synthetic-entry-learning-followup", "synthetic-entry-ai-doctor-summary"] } }, select: { id: true, versionNumber: true, updatedAt: true } });
    console.log(JSON.stringify({ ok: true, versions, audits, sysEvents, hl, ent: ent.map(e => ({ id: e.id, v: e.versionNumber, u: e.updatedAt.toISOString() })) }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(JSON.stringify({ ok: false, code: e && e.code })); process.exit(1); });
"""


def probe(ids):
    root = os.path.dirname(os.path.abspath(__file__))
    client_path = os.path.join(root, "src", "generated", "prisma", "client")
    with tempfile.TemporaryDirectory(prefix="nightingale-prov-probe-") as tmp:
        rel = os.path.relpath(os.path.realpath(client_path), start=os.path.realpath(tmp)).replace(os.sep, "/")
        if not rel.startswith("."):
            rel = "./" + rel
        script = PROBE_TEMPLATE.replace("__PRISMA_CLIENT_IMPORT__", rel).replace("__ENTRY_IDS_JSON__", json.dumps(ids))
        path = os.path.join(tmp, "probe.ts")
        with open(path, "w", encoding="utf-8") as f:
            f.write(script)
        env = {**os.environ, "NODE_PATH": os.path.join(root, "node_modules")}
        proc = subprocess.run(["npx", "tsx", path], cwd=root, capture_output=True, text=True, timeout=60, env=env)
    lines = (proc.stdout or "").strip().splitlines()
    try:
        return json.loads(lines[-1]) if lines else None
    except json.JSONDecodeError:
        return None


def run():
    print(f"Target: {BASE_URL}\n")

    # ─── no-mutation probe: before ────────────────────────────────────
    before = probe([HL_POSITIVE, HL_CRITICAL, HL_AI])

    # ─── A / F  positive exact-anchor case ───────────────────────────
    s, rows = highlights("clinician_a", LEARNING)
    pos = find(rows, HL_POSITIVE)
    check("A. Clinician A GET learning highlights -> 200", s == 200 and isinstance(rows, list))
    check(
        "F. positive case: quotedTextFound true, occurrenceCount 1, quotedText "
        "is a verbatim substring of entryContent, entryId links the source",
        pos is not None
        and pos["quotedTextFound"] is True
        and pos["occurrenceCount"] == 1
        and pos["quotedText"] in pos["entryContent"]
        and pos["entryContent"].count(pos["quotedText"]) == 1
        and pos["entryId"] == ENTRY_FOLLOWUP,
    )
    s, e = entry("clinician_a", pos["entryId"]) if pos else (0, None)
    check("A2. linked source entry retrievable by Clinician -> 200, content matches highlight",
          s == 200 and isinstance(e, dict) and e["content"] == pos["entryContent"])

    # ─── G  critical negative-anchor case ───────────────────────────
    crit = find(rows, HL_CRITICAL)
    check(
        "G. critical case: linked entry present, quotedTextFound FALSE, "
        "occurrenceCount 0, riskFloor still 'critical', quote absent from content",
        crit is not None
        and crit["entryId"] == ENTRY_RISKFLAG
        and crit["quotedTextFound"] is False
        and crit["occurrenceCount"] == 0
        and crit["riskFloor"] == "critical"
        and crit["quotedText"] not in crit["entryContent"],
    )
    s, e = entry("clinician_a", ENTRY_RISKFLAG)
    check("G2. critical's linked source entry is still retrievable -> 200", s == 200 and isinstance(e, dict))

    # ─── H  AI Scribe provenance distinct + unchanged ──────────────
    s, arows = highlights("clinician_a", PATIENT_A)
    ai = find(arows, HL_AI)
    check(
        "H. AI-doctor highlight carries entryProvenanceType 'doctor_consult' + "
        "a concrete session id; quote found once",
        ai is not None
        and ai["entryProvenanceType"] == "doctor_consult"
        and ai["entryProvenanceId"] == "synthetic-session-consult-001"
        and ai["quotedTextFound"] is True
        and ai["occurrenceCount"] == 1,
    )
    s, e = entry("clinician_a", ENTRY_AI_DOCTOR_A)
    check("H2. AI-doctor source entry: type ai_doctor_consult_summary, provenance intact",
          s == 200 and e["type"] == "ai_doctor_consult_summary"
          and e["provenanceType"] == "doctor_consult" and e["provenanceId"] == "synthetic-session-consult-001")
    # distinctness across the three Learning-Patient AI Scribe types
    trip = {}
    for eid in ["synthetic-entry-learning-ai-doctor", "synthetic-entry-learning-ai-nurse", "synthetic-entry-learning-ai-patient"]:
        _, ee = entry("clinician_a", eid)
        trip[eid] = (ee["provenanceType"], ee["provenanceId"])
    check("H3. three Learning-Patient AI Scribe types keep distinct provenanceType + provenanceId",
          len({v[0] for v in trip.values()}) == 3 and len({v[1] for v in trip.values()}) == 3)

    # ─── B / C  Staff + Admin per existing contract ────────────────
    check("B. Staff A GET learning highlights -> 200", highlights("staff_a", LEARNING)[0] == 200)
    check("B2. Staff A GET source entry -> 200", entry("staff_a", ENTRY_FOLLOWUP)[0] == 200)
    check("C. Admin A GET learning highlights -> 200", highlights("admin_a", LEARNING)[0] == 200)
    check("C2. Admin A GET source entry -> 200", entry("admin_a", ENTRY_FOLLOWUP)[0] == 200)

    # ─── D  Patient denied Highlight provenance ────────────────────
    ps, pb = highlights("patient_a", PATIENT_A)
    check("D. Patient A GET highlights -> 403, no provenance payload", ps == 403 and not isinstance(pb, list))
    check("D2. Patient A GET the AI-doctor internal source entry -> 404 (existence hidden)",
          entry("patient_a", ENTRY_AI_DOCTOR_A)[0] == 404)

    # ─── E  cross-clinic cannot reach the source entry ────────────
    check("E. Clinician B GET a Clinic A source entry -> 403", entry("clinician_b", ENTRY_FOLLOWUP)[0] == 403)
    check("E2. Clinician B GET Clinic A highlights -> 403", highlights("clinician_b", LEARNING)[0] == 403)

    # ─── J  Scenario C oldest-group source entries retrievable ────
    ok_oldest = True
    for eid in OLDEST_GROUP_ENTRIES:
        s, e = entry("clinician_a", eid)
        ok_oldest = ok_oldest and s == 200 and e["createdAt"].startswith("2025-04-15")
    check("J. oldest Scenario C group (15 Apr 2025) source entries are individually retrievable",
          ok_oldest)

    # ─── I  no-mutation proof ────────────────────────────────────
    after = probe([HL_POSITIVE, HL_CRITICAL, HL_AI])
    check(
        "I. a batch of provenance GETs mutated nothing (Version/AuditEvent/"
        "system_event counts, Highlight feedback+importance, entry "
        "versionNumber+updatedAt all identical)",
        before is not None and after is not None and before == after,
    )
    if before != after:
        print(f"   before={json.dumps(before)}")
        print(f"   after ={json.dumps(after)}")


if __name__ == "__main__":
    try:
        run()
    except Exception as e:  # noqa: BLE001
        print(f"ERROR during test run: {type(e).__name__}: {e}")
        results.append(False)
    total = len(results)
    passed = sum(1 for r in results if r)
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if passed == total else 1)
