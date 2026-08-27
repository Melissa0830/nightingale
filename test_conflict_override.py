"""
test_conflict_override.py

Micro-test: the `isClinicianOverride` conflict-flagging path in
PUT /api/timeline/:id (src/app/api/timeline/[id]/route.ts) — a Clinician
editing content that originated from an AI-scribed entry.

This closes the Pass 1 capability-matrix gap on row 27 ("Conflict flag
presentation"): the well-tested stale-write 409 path (see
test_concurrent_edits.py, cases G1B1-G1B4/H1-H2) is a DIFFERENT code path
from isClinicianOverride, and no required test previously exercised the
override branch or its visible system_event side effect.

Black-box HTTP test against a running Next.js dev server — same convention
as test_concurrent_edits.py / test_revision_history.py / test_rbac_scope.py.
Auth tokens are obtained via POST /api/auth/login using synthetic fixture
emails from prisma/seed.ts (never hand-signed).

Scenario design (verified against source before writing assertions, not
assumed):
  - Entry A (override target): an AI-scribed entry created via
    POST /api/patients/:id/ai-scribe (sessionType=doctor_consult). This
    gets sectionKey="summary" (Clinician-owned, so the write is not
    blocked by section ownership) and authorRole=system + type=
    ai_doctor_consult_summary, both of which independently satisfy
    isClinicianOverride's predicate. A Clinician PUT against it is
    expected to succeed AND emit an extra conflict_flagged AuditEvent
    (with versionId set — a real snapshot exists) plus a new visible
    system_event TimelineEntry, in the SAME transaction as the successful
    write (per source: STEP 3/STEP 4 of the PUT transaction).
  - Entry B (stale-write control, re-derived independently of
    test_concurrent_edits.py so this file's assertions do not depend on
    another suite's fixtures): a plain Clinician-authored clinician_note
    (sectionKey="plan", not AI/Patient/system-authored) subjected to one
    valid write then one stale write at the same expectedVersion. This
    reproduces the OTHER conflict_flagged trigger (409, versionId=null,
    no system_event) so both paths can be asserted side-by-side in one
    probe and shown to be distinguishable.
  - Entry C (clean control): a plain Clinician-authored clinician_note
    (sectionKey="medication") with exactly one successful, non-stale,
    non-override write. Expected: zero conflict_flagged rows, zero
    system_event rows tied to it — a negative control proving the
    override/stale mechanisms do not fire spuriously.
  - Entry D: the auto-created system_event TimelineEntry produced by
    Entry A's override write. Not created via any direct endpoint — its
    ID is discovered by diffing GET /api/patients/:id/timeline (Clinician
    actor, unfiltered) before and after the override PUT.

No AuditEvent-reading endpoint exists anywhere in this API (same finding
as test_revision_history.py / test_concurrent_edits.py). AuditEvent
metadata is read via the same read-only, metadata-only Prisma probe
mechanism already used in those files — findMany() only, never
create/update/delete, selecting only id/action/actorRole/timelineEntryId/
versionId/createdAt. It never selects or prints TimelineEntry.content,
Version.content, DATABASE_URL, or secrets.

Cleanup: all four entries this test creates (A, B, C, D) are recorded by
exact ID and deleted via the same exact-ID Prisma cleanup script already
approved for test_concurrent_edits.py (AuditEvent -> AiScribedNote ->
Version -> TimelineEntry, keyed by id IN the exact recorded list). No
patient-wide, type-wide, content-based, or timestamp-window delete
anywhere. Reseed is not used as this test's cleanup mechanism — baseline
restoration is verified by TimelineEntry count before/after cleanup.

Prerequisites:
  1. Database seeded with the fixed synthetic fixtures:
       npx tsx prisma/seed.ts
  2. Next.js dev server running:
       npm run dev
     (defaults to http://localhost:3000; override with NIGHTINGALE_BASE_URL)
  3. `npx tsx` available (already a devDependency) — needed only for the
     read-only AuditEvent probe and cleanup, not for the HTTP assertions.

PHI-safe stdout: no check() label or printed line contains raw entry
content — only case descriptions, counts, and IDs (opaque cuids, not PHI).

Usage:
  python3 test_conflict_override.py

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

FIXTURE_EMAILS = {
    "staff_a": "staff.a@clinic-a.test",
    "clinician_a": "clinician.a@clinic-a.test",
}
PATIENT_A_ID = "synthetic-patient-a"

# Plain, non-PHI content for each write, kept distinguishable so
# content-equality assertions unambiguously identify which write "won".
AI_RAW_TEXT = "Patient reports persistent headache; no red flags noted at this time."
CLINICIAN_OVERRIDE_CONTENT = (
    "Clinician correction: escalate for cardiology referral due to atypical presentation."
)

B_INITIAL = "Plan: override-test-B initial content."
B_FIRST_WRITE = "Plan: override-test-B first writer content."
B_STALE_WRITE = "Plan: override-test-B stale second writer content - must be rejected."

C_INITIAL = "Medication: override-test-C initial content."
C_EDIT = "Medication: override-test-C edited by Clinician (clean, non-conflicting)."

SYSTEM_EVENT_EXPECTED_CONTENT = "Conflict flagged for clinician review"

_token_cache = {}
results = []
created_entry_ids = []  # exact IDs this test creates: [A, B, C, D(system_event)]


def _http_json(method, path, token=None, body=None):
    url = f"{BASE_URL}{path}"
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            parsed = json.loads(raw.decode("utf-8")) if raw else None
            return resp.status, parsed
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else None
        except json.JSONDecodeError:
            parsed = None
        return e.code, parsed
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Cannot reach {BASE_URL} — is the Next.js dev server running? ({e.reason})"
        ) from e


def login(email):
    if email in _token_cache:
        return _token_cache[email]
    status, payload = _http_json("POST", "/api/auth/login", body={"email": email})
    if status != 200 or not isinstance(payload, dict) or not payload.get("token"):
        raise RuntimeError(
            f"Login failed for {email} (status {status}); "
            "check that the database has been seeded"
        )
    token = payload["token"]
    _token_cache[email] = token
    return token


def check(name, condition):
    results.append(bool(condition))
    label = "PASS" if condition else "FAIL"
    print(f"[{label}] {name}")


def get_id(body):
    return body.get("id") if isinstance(body, dict) else None


def create_entry(actor_key, entry_type, content, section_key=None):
    token = login(FIXTURE_EMAILS[actor_key])
    body = {"content": content, "patientId": PATIENT_A_ID, "type": entry_type}
    if section_key is not None:
        body["sectionKey"] = section_key
    return _http_json("POST", "/api/timeline", token=token, body=body)


def create_ai_scribe_entry(actor_key, session_type, session_id, raw_text):
    token = login(FIXTURE_EMAILS[actor_key])
    body = {"sessionType": session_type, "sessionId": session_id, "rawText": raw_text}
    return _http_json(
        "POST", f"/api/patients/{PATIENT_A_ID}/ai-scribe", token=token, body=body
    )


def put_entry(actor_key, entry_id, content, expected_version):
    token = login(FIXTURE_EMAILS[actor_key])
    return _http_json(
        "PUT",
        f"/api/timeline/{entry_id}",
        token=token,
        body={"content": content, "expectedVersion": expected_version},
    )


def get_versions(actor_key, entry_id):
    token = login(FIXTURE_EMAILS[actor_key])
    return _http_json("GET", f"/api/timeline/{entry_id}/versions", token=token)


def get_entry(actor_key, entry_id):
    token = login(FIXTURE_EMAILS[actor_key])
    return _http_json("GET", f"/api/timeline/{entry_id}", token=token)


def timeline_entries(actor_key, patient_id):
    token = login(FIXTURE_EMAILS[actor_key])
    status, payload = _http_json(
        "GET", f"/api/patients/{patient_id}/timeline", token=token
    )
    if status != 200 or not isinstance(payload, list):
        raise RuntimeError(f"Unexpected response listing timeline (status {status})")
    return [e for e in payload if isinstance(e, dict) and isinstance(e.get("id"), str)]


def timeline_entry_ids(actor_key, patient_id):
    return {e["id"] for e in timeline_entries(actor_key, patient_id)}


def count_timeline_entries(actor_key, patient_id):
    return len(timeline_entry_ids(actor_key, patient_id))


# ─── Throwaway tsx script runner: identical mechanism to
# test_concurrent_edits.py / test_revision_history.py (NODE_PATH + realpath
# fixes both required for a script in an OS temp dir to resolve dotenv/config,
# @prisma/adapter-pg, and the generated Prisma client).
def _run_tsx_script(script_template, entry_ids, script_name):
    project_root = os.path.dirname(os.path.abspath(__file__))
    prisma_client_path = os.path.join(project_root, "src", "generated", "prisma", "client")

    try:
        with tempfile.TemporaryDirectory(prefix="nightingale-conflict-override-") as tmpdir:
            script_path = os.path.join(tmpdir, script_name)
            rel_import = os.path.relpath(
                os.path.realpath(prisma_client_path), start=os.path.realpath(tmpdir)
            ).replace(os.sep, "/")
            if not rel_import.startswith("."):
                rel_import = "./" + rel_import
            script_content = script_template.replace(
                "__PRISMA_CLIENT_IMPORT__", rel_import
            ).replace("__ENTRY_IDS_JSON__", json.dumps(entry_ids))
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(script_content)

            env = {**os.environ, "NODE_PATH": os.path.join(project_root, "node_modules")}
            proc = subprocess.run(
                ["npx", "tsx", script_path],
                cwd=project_root,
                capture_output=True,
                text=True,
                timeout=60,
                env=env,
            )
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, None, f"subprocess failed to run: {type(e).__name__}"

    stdout_lines = (proc.stdout or "").strip().splitlines()
    last_line = stdout_lines[-1] if stdout_lines else ""
    try:
        payload = json.loads(last_line) if last_line else None
    except json.JSONDecodeError:
        payload = None

    if proc.returncode != 0 or not isinstance(payload, dict) or not payload.get("ok"):
        code = payload.get("code") if isinstance(payload, dict) else None
        return False, payload, f"script exited {proc.returncode} (code={code})"

    return True, payload, None


CLEANUP_SCRIPT_TEMPLATE = """\
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "__PRISMA_CLIENT_IMPORT__";

const entryIds = __ENTRY_IDS_JSON__;

async function main() {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    if (entryIds.length === 0) {
      console.log(JSON.stringify({
        ok: true, idsRequested: 0,
        deletedAuditEvents: 0, deletedAiScribedNotes: 0,
        deletedVersions: 0, deletedTimelineEntries: 0,
      }));
      return;
    }
    const auditResult = await prisma.auditEvent.deleteMany({ where: { timelineEntryId: { in: entryIds } } });
    const aiNoteResult = await prisma.aiScribedNote.deleteMany({ where: { timelineEntryId: { in: entryIds } } });
    const versionResult = await prisma.version.deleteMany({ where: { timelineEntryId: { in: entryIds } } });
    const entryResult = await prisma.timelineEntry.deleteMany({ where: { id: { in: entryIds } } });
    console.log(JSON.stringify({
      ok: true,
      idsRequested: entryIds.length,
      deletedAuditEvents: auditResult.count,
      deletedAiScribedNotes: aiNoteResult.count,
      deletedVersions: versionResult.count,
      deletedTimelineEntries: entryResult.count,
    }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  // Deliberately no e.message here: a Prisma connection error can embed the
  // connection string, and DATABASE_URL must never reach stdout/stderr.
  console.error(JSON.stringify({ ok: false, error: "cleanup failed", code: e && e.code ? e.code : undefined }));
  process.exit(1);
});
"""

# Read-only, metadata-only: AuditEvent fields only. No create/update/delete.
READ_PROBE_SCRIPT_TEMPLATE = """\
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "__PRISMA_CLIENT_IMPORT__";

const entryIds = __ENTRY_IDS_JSON__;

async function main() {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const auditEvents = await prisma.auditEvent.findMany({
      where: { timelineEntryId: { in: entryIds } },
      select: {
        id: true,
        action: true,
        actorRole: true,
        timelineEntryId: true,
        versionId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    console.log(JSON.stringify({ ok: true, auditEvents }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: "read probe failed", code: e && e.code ? e.code : undefined }));
  process.exit(1);
});
"""


def cleanup(entry_ids):
    return _run_tsx_script(CLEANUP_SCRIPT_TEMPLATE, entry_ids, "cleanup.ts")


def read_audit_events(entry_ids):
    ok, payload, error = _run_tsx_script(READ_PROBE_SCRIPT_TEMPLATE, entry_ids, "probe.ts")
    if not ok or not isinstance(payload, dict):
        return None, error
    audit_events = payload.get("auditEvents")
    if not isinstance(audit_events, list):
        return None, "probe returned malformed payload"
    return audit_events, None


def run_tests():
    print(f"Target: {BASE_URL}\n")

    # ─── Entry A fixture: AI-scribed entry (override target) ──────────────
    print("-- Entry A fixture: AI-scribed entry via POST /ai-scribe --")
    status, body = create_ai_scribe_entry(
        "staff_a", "doctor_consult", "test-override-session-01", AI_RAW_TEXT
    )
    a_id = get_id(body)
    if a_id is not None:
        created_entry_ids.append(a_id)
    check(
        "A-fixture. AI-scribed entry created (type=ai_doctor_consult_summary, "
        "sectionKey=summary, versionNumber=1)",
        status == 201 and a_id is not None and isinstance(body, dict)
        and body.get("type") == "ai_doctor_consult_summary"
        and body.get("sectionKey") == "summary"
        and body.get("versionNumber") == 1,
    )

    # ─── Entry B fixture: plain Clinician-owned entry (stale-write control) ─
    print("\n-- Entry B fixture: plain Clinician plan entry (stale-write control) --")
    status, body = create_entry("clinician_a", "clinician_note", B_INITIAL, section_key="plan")
    b_id = get_id(body)
    if b_id is not None:
        created_entry_ids.append(b_id)
    check(
        "B-fixture. Clinician-authored plan entry created (versionNumber=1)",
        status == 201 and b_id is not None and isinstance(body, dict)
        and body.get("versionNumber") == 1 and body.get("sectionKey") == "plan",
    )

    # ─── Entry C fixture: plain Clinician-owned entry (clean control) ─────
    print("\n-- Entry C fixture: plain Clinician medication entry (clean control) --")
    status, body = create_entry(
        "clinician_a", "clinician_note", C_INITIAL, section_key="medication"
    )
    c_id = get_id(body)
    if c_id is not None:
        created_entry_ids.append(c_id)
    check(
        "C-fixture. Clinician-authored medication entry created (versionNumber=1)",
        status == 201 and c_id is not None and isinstance(body, dict)
        and body.get("versionNumber") == 1 and body.get("sectionKey") == "medication",
    )

    if a_id is None or b_id is None or c_id is None:
        print("FATAL: one or more fixtures failed to create, aborting remaining scenarios")
        return

    # ─── Baseline timeline snapshot, taken AFTER fixtures exist but BEFORE
    # the override write, so the only entry the diff can attribute to the
    # override write is the system_event it creates. ────────────────────
    baseline_ids = timeline_entry_ids("clinician_a", PATIENT_A_ID)

    # ─── Entry A: the override write ───────────────────────────────────────
    print("\n-- A1: Clinician overrides the AI-scribed entry --")
    status, body = put_entry("clinician_a", a_id, CLINICIAN_OVERRIDE_CONTENT, 1)
    check(
        "A1. Clinician PUT on AI-scribed entry succeeds -> 200, versionNumber=2, "
        "content = clinician's correction",
        status == 200 and isinstance(body, dict)
        and body.get("versionNumber") == 2
        and body.get("content") == CLINICIAN_OVERRIDE_CONTENT,
    )

    v_status, v_body = get_versions("clinician_a", a_id)
    vb = v_body if isinstance(v_body, dict) else {}
    a_versions = vb.get("versions") if isinstance(vb.get("versions"), list) else []
    check(
        "A2. exactly one historical Version row for entry A "
        "(v1 = original AI-generated content, verbatim mock adapter output)",
        v_status == 200 and len(a_versions) == 1
        and a_versions[0].get("versionNumber") == 1
        and a_versions[0].get("content")
        == f"AI Scribe Summary (doctor_consult): {AI_RAW_TEXT}",
    )

    status2, body2 = get_entry("clinician_a", a_id)
    check(
        "A3. live content of entry A is the clinician's correction, "
        "live versionNumber=2",
        status2 == 200 and isinstance(body2, dict)
        and body2.get("content") == CLINICIAN_OVERRIDE_CONTENT
        and body2.get("versionNumber") == 2,
    )

    # ─── Entry D discovery: diff timeline before/after the override write ──
    print("\n-- A4: discover the auto-created system_event entry (Entry D) --")
    after_override_entries = timeline_entries("clinician_a", PATIENT_A_ID)
    after_override_ids = {e["id"] for e in after_override_entries}
    new_ids = after_override_ids - baseline_ids
    check(
        "A4. exactly one new TimelineEntry appeared after the override write",
        len(new_ids) == 1,
    )
    d_id = next(iter(new_ids)) if len(new_ids) == 1 else None
    if d_id is not None:
        created_entry_ids.append(d_id)
        d_entry = next((e for e in after_override_entries if e["id"] == d_id), None)
        check(
            "A5. the new entry is type=system_event, sectionKey=null, "
            f"content='{SYSTEM_EVENT_EXPECTED_CONTENT}' (human-readable, "
            "corresponds to the override event)",
            isinstance(d_entry, dict)
            and d_entry.get("type") == "system_event"
            and d_entry.get("sectionKey") is None
            and d_entry.get("content") == SYSTEM_EVENT_EXPECTED_CONTENT,
        )
    else:
        check(
            "A5. the new entry is type=system_event with the expected content",
            False,
        )

    # ─── Entry B: valid write then stale write (independent stale-write
    # control, reproduced here for direct side-by-side comparison) ────────
    print("\n-- B1: first (valid) write on Entry B --")
    status, body = put_entry("clinician_a", b_id, B_FIRST_WRITE, 1)
    check(
        "B1. first write with expectedVersion=1 succeeds -> 200, versionNumber=2",
        status == 200 and isinstance(body, dict)
        and body.get("versionNumber") == 2 and body.get("content") == B_FIRST_WRITE,
    )

    print("\n-- B2: stale write on Entry B (same expectedVersion=1, now outdated) --")
    status, body = put_entry("clinician_a", b_id, B_STALE_WRITE, 1)
    check(
        "B2. stale write with expectedVersion=1 -> 409",
        status == 409,
    )
    status2, body2 = get_entry("clinician_a", b_id)
    check(
        "B3. live content of entry B remains the first write "
        "(stale write B was rejected, not applied)",
        status2 == 200 and isinstance(body2, dict) and body2.get("content") == B_FIRST_WRITE,
    )

    # ─── Entry C: single clean write, no staleness, no override ───────────
    print("\n-- C1: single clean write on Entry C --")
    status, body = put_entry("clinician_a", c_id, C_EDIT, 1)
    check(
        "C1. clean write with expectedVersion=1 succeeds -> 200, versionNumber=2",
        status == 200 and isinstance(body, dict)
        and body.get("versionNumber") == 2 and body.get("content") == C_EDIT,
    )

    # ─── AuditEvent metadata (read-only probe, metadata-only) ─────────────
    print("\n-- H. AuditEvent metadata (read-only probe) --")
    probe_ids = [a_id, b_id, c_id] + ([d_id] if d_id is not None else [])
    audit_events, probe_error = read_audit_events(probe_ids)

    if audit_events is None:
        check("H0. read-only AuditEvent probe succeeded", False)
        print(f"PROBE FAILURE: {probe_error}")
    else:
        check("H0. read-only AuditEvent probe succeeded", True)

        def action_counts_for(entry_id):
            counts = {}
            for ev in audit_events:
                if ev.get("timelineEntryId") == entry_id:
                    counts[ev.get("action")] = counts.get(ev.get("action"), 0) + 1
            return counts

        a_counts = action_counts_for(a_id)
        check(
            "H1. Entry A (override) has exactly 3 AuditEvent rows: "
            "note_created x1 (ai-scribe ingestion), note_updated x1, "
            "conflict_flagged x1 (from isClinicianOverride)",
            a_counts == {"note_created": 1, "note_updated": 1, "conflict_flagged": 1},
        )

        a_conflict_event = next(
            (ev for ev in audit_events if ev.get("timelineEntryId") == a_id
             and ev.get("action") == "conflict_flagged"),
            None,
        )
        check(
            "H2. Entry A's conflict_flagged AuditEvent has versionId SET "
            "(a real snapshot exists — same transaction as the successful write)",
            isinstance(a_conflict_event, dict) and a_conflict_event.get("versionId") is not None,
        )

        b_counts = action_counts_for(b_id)
        check(
            "H3. Entry B (stale-write control) has exactly 3 AuditEvent rows: "
            "note_created x1, note_updated x1, conflict_flagged x1 "
            "(from the stale write, NOT from isClinicianOverride — entry B "
            "is a plain Clinician-authored clinician_note)",
            b_counts == {"note_created": 1, "note_updated": 1, "conflict_flagged": 1},
        )

        b_conflict_event = next(
            (ev for ev in audit_events if ev.get("timelineEntryId") == b_id
             and ev.get("action") == "conflict_flagged"),
            None,
        )
        check(
            "H4. Entry B's conflict_flagged AuditEvent has versionId=NULL "
            "(stale write: no snapshot exists to point to) — this is the "
            "concrete distinction from Entry A's override conflict_flagged (H2)",
            isinstance(b_conflict_event, dict) and b_conflict_event.get("versionId") is None,
        )

        c_counts = action_counts_for(c_id)
        check(
            "H5. Entry C (clean control) has exactly 2 AuditEvent rows: "
            "note_created x1, note_updated x1 — ZERO conflict_flagged "
            "(no override, no staleness: proves the mechanism does not "
            "fire spuriously)",
            c_counts == {"note_created": 1, "note_updated": 1},
        )

        if d_id is not None:
            d_counts = action_counts_for(d_id)
            check(
                "H6. Entry D (the system_event marker itself) has ZERO "
                "AuditEvent rows of its own — audit events attach to the "
                "edited entry (A), never to the system_event record",
                d_counts == {},
            )
        else:
            check("H6. Entry D (the system_event marker itself) has ZERO AuditEvent rows", False)

        total_conflict_flagged = sum(
            1 for ev in audit_events if ev.get("action") == "conflict_flagged"
        )
        check(
            "H7. exactly 2 conflict_flagged AuditEvent rows total across A/B/C "
            "(one per triggering entry — no unrelated conflict_flagged rows)",
            total_conflict_flagged == 2,
        )

        check(
            "H8. every observed AuditEvent has actorRole=Clinician "
            "(all writes and the ai-scribe ingestion were performed as "
            "staff_a/clinician_a; ai-scribe ingestion actorRole is Staff)",
            all(ev.get("actorRole") in ("Clinician", "Staff") for ev in audit_events),
        )


if __name__ == "__main__":
    baseline_count = None
    try:
        baseline_count = count_timeline_entries("clinician_a", PATIENT_A_ID)
    except Exception as e:  # noqa: BLE001 - last-resort guard, see module docstring
        print(f"ERROR establishing baseline: {type(e).__name__}: {e}")
        results.append(False)

    try:
        run_tests()
    except Exception as e:  # noqa: BLE001 - never let TypeError/KeyError/etc. crash the run
        print(f"ERROR during test run: {type(e).__name__}: {e}")
        results.append(False)
    finally:
        cleanup_ok, cleanup_counts, cleanup_error = cleanup(created_entry_ids)

    print("\n-- Cleanup --")
    if cleanup_ok:
        check("cleanup. temp Prisma cleanup script succeeded", True)
        expected_entries = len(created_entry_ids)
        counts_ok = (
            isinstance(cleanup_counts, dict)
            and cleanup_counts.get("deletedTimelineEntries") == expected_entries
        )
        check(
            "cleanup. deletedTimelineEntries matches number of ids recorded",
            counts_ok,
        )
        print(f"cleanup counts: {cleanup_counts}")
    else:
        check("cleanup. temp Prisma cleanup script succeeded", False)
        print(f"CLEANUP FAILURE: {cleanup_error}")

    if baseline_count is not None:
        try:
            final_count = count_timeline_entries("clinician_a", PATIENT_A_ID)
            check(
                "cleanup. TimelineEntry count restored to pre-run baseline",
                final_count == baseline_count,
            )
        except Exception as e:  # noqa: BLE001
            check("cleanup. TimelineEntry count restored to pre-run baseline", False)
            print(f"ERROR verifying post-cleanup baseline: {type(e).__name__}: {e}")
    else:
        check("cleanup. TimelineEntry count restored to pre-run baseline", False)

    total = len(results)
    passed = sum(results)
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if (passed == total and cleanup_ok) else 1)
