"""
test_timeline_chronology.py

Core Gap Closure 1: the Synthetic Learning Patient Timeline is a truthful
longitudinal record and GET /api/patients/:id/timeline returns entries
newest-first with a deterministic tie-break.

Read-only. No writes, no fixture creation, no cleanup. Safe to run at any
time against a seeded database.

Covers:
  - API ordering: createdAt DESC, then id ASC (deterministic, repeatable)
  - Scenario C span: entries in 2025, early 2026, and Aug 2026 all present
  - the exact seeded createdAt values for all 9 Learning Patient entries
  - Patient-role filtering unchanged (only patient_session_summary)
  - same-clinic staff access (Clinician / Staff / Admin -> 200)
  - cross-clinic denial (Clinician B -> 403)
  - Glance Recent Changes stays updatedAt-based, not createdAt chronology

Setup:
  1. npx tsx prisma/seed.ts
  2. dev server running (NIGHTINGALE_BASE_URL, default http://localhost:3000)

Run:
  NIGHTINGALE_BASE_URL=http://localhost:3100 python3 test_timeline_chronology.py

Exit code: 0 if all cases pass, 1 otherwise.
"""

import json
import os
import sys
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

# Exact seeded createdAt values — must match prisma/seed.ts and must survive
# repeated reseeds unchanged (see the two-reseed persistence check in the
# block report).
EXPECTED_LEARNING_DATES = {
    "synthetic-entry-learning-patient-summary": "2025-04-15T09:00:00.000Z",
    "synthetic-entry-learning-staff-note": "2025-04-15T09:30:00.000Z",
    "synthetic-entry-learning-followup": "2026-02-06T10:00:00.000Z",
    "synthetic-entry-learning-medreview": "2026-02-06T10:15:00.000Z",
    "synthetic-entry-learning-riskflag": "2026-02-06T10:30:00.000Z",
    "synthetic-entry-learning-ai-patient": "2026-08-27T08:30:00.000Z",
    "synthetic-entry-learning-ai-nurse": "2026-08-27T09:00:00.000Z",
    "synthetic-entry-learning-ai-doctor": "2026-08-27T09:30:00.000Z",
    "synthetic-entry-learning-plan": "2026-08-27T10:00:00.000Z",
}

_tok = {}
results = []


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


def timeline(actor, pid):
    return http("GET", f"/api/patients/{pid}/timeline", token=login(actor))


def run():
    print(f"Target: {BASE_URL}\n")

    # ─── Same-clinic access ──────────────────────────────────────────────
    for actor in ("clinician_a", "staff_a", "admin_a"):
        s, _ = timeline(actor, LEARNING)
        check(f"A. {actor} GET learning timeline -> 200", s == 200)

    s, _ = timeline("clinician_b", LEARNING)
    check("A. Clinician B (Clinic B) GET learning timeline -> 403", s == 403)

    # ─── Ordering: newest-first, deterministic ───────────────────────────
    s, rows = timeline("clinician_a", LEARNING)
    ok = s == 200 and isinstance(rows, list) and len(rows) == 9
    check("B1. learning timeline returns 200 with all 9 entries", ok)
    if not ok:
        return

    created = [r["createdAt"] for r in rows]
    check(
        "B2. entries are newest-first (createdAt DESC, non-increasing)",
        all(created[i] >= created[i + 1] for i in range(len(created) - 1)),
    )
    check(
        "B3. first entry is the most recent, last is the oldest",
        created[0] == "2026-08-27T10:00:00.000Z"
        and created[-1] == "2025-04-15T09:00:00.000Z",
    )

    s2, rows2 = timeline("clinician_a", LEARNING)
    check(
        "B4. ordering is deterministic across repeated calls "
        "(same id sequence both times)",
        s2 == 200
        and [r["id"] for r in rows2] == [r["id"] for r in rows],
    )

    # createdAt DESC then id ASC: for any adjacent pair with equal
    # createdAt, id must be ascending. (The seed uses distinct timestamps,
    # so this asserts the rule holds rather than exercising a collision.)
    tie_ok = True
    for i in range(len(rows) - 1):
        if rows[i]["createdAt"] == rows[i + 1]["createdAt"]:
            tie_ok = tie_ok and rows[i]["id"] < rows[i + 1]["id"]
    check("B5. equal-createdAt pairs (if any) are ordered by id ASC", tie_ok)

    # ─── Scenario C longitudinal span ───────────────────────────────────
    by_id = {r["id"]: r for r in rows}
    check(
        "C1. every Learning Patient entry has its exact seeded createdAt",
        all(
            eid in by_id and by_id[eid]["createdAt"] == want
            for eid, want in EXPECTED_LEARNING_DATES.items()
        ),
    )
    years = {r["createdAt"][:7] for r in rows}
    check(
        "C2. span covers three meaningfully separated periods "
        "(2025-04, 2026-02, 2026-08)",
        {"2025-04", "2026-02", "2026-08"}.issubset(years),
    )
    check(
        "C3. at least one 2025 historical entry is present",
        any(r["createdAt"].startswith("2025") for r in rows),
    )
    check(
        "C4. the current-consult day is in clinical order "
        "(patient check-in -> nurse -> doctor -> plan)",
        [r["id"] for r in rows if r["createdAt"].startswith("2026-08-27")]
        == [
            "synthetic-entry-learning-plan",
            "synthetic-entry-learning-ai-doctor",
            "synthetic-entry-learning-ai-nurse",
            "synthetic-entry-learning-ai-patient",
        ],
    )

    # ─── Patient-role filtering unchanged ───────────────────────────────
    s, prows = timeline("patient_a", PATIENT_A)
    check(
        "D1. Patient A timeline (Patient role) is still only "
        "patient_session_summary",
        s == 200
        and isinstance(prows, list)
        and {r["type"] for r in prows} == {"patient_session_summary"},
    )
    s, prows = timeline("clinician_a", PATIENT_A)
    check(
        "D2. Patient A timeline (Clinician role) is also newest-first",
        s == 200
        and all(
            prows[i]["createdAt"] >= prows[i + 1]["createdAt"]
            for i in range(len(prows) - 1)
        ),
    )

    # ─── Glance Recent Changes stays updatedAt-based ────────────────────
    s, g = http("GET", f"/api/patients/{LEARNING}/glance", token=login("clinician_a"))
    rc = g.get("recentChanges", []) if isinstance(g, dict) else []
    check(
        "E1. Glance recentChanges returns 5 rows ordered by updatedAt DESC "
        "(not affected by Scenario C createdAt history)",
        s == 200
        and len(rc) == 5
        and all(
            rc[i]["updatedAt"] >= rc[i + 1]["updatedAt"] for i in range(len(rc) - 1)
        ),
    )


if __name__ == "__main__":
    try:
        run()
    except Exception as e:  # noqa: BLE001 - never crash the run
        print(f"ERROR during test run: {type(e).__name__}: {e}")
        results.append(False)
    total = len(results)
    passed = sum(1 for r in results if r)
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if passed == total else 1)
