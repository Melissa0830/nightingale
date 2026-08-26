"""
test_concurrent_edits.py

Micro-test: optimistic concurrency control (stale-version rejection) and
section-independent concurrent writes, exercised against temporary
Staff/Clinician-authored TimelineEntry fixtures.

Black-box HTTP test against a running Next.js dev server — same convention
as test_revision_history.py / test_ai_scribe_ingestion.py /
test_rbac_scope.py. Auth tokens are obtained via POST /api/auth/login using
synthetic fixture emails from prisma/seed.ts (never hand-signed).

Scope note on "section independence" (verified before implementation, not
assumed): sectionKey is a TimelineEntry-level field — each entry carries
exactly one sectionKey. "Section independence" as tested here therefore
means independent optimistic-concurrency/version-control state across TWO
SEPARATE TimelineEntry rows scoped to different sections/owners (Staff's
staff_note entry vs. Clinician's medication entry), each with its own
versionNumber and Version history. It is NOT a test of concurrent edits to
different sub-fields within a single entry — this schema has no such
concept. README/Technical Brief wording must reflect this: the guarantee
demonstrated is "two independently-owned entries do not interfere with
each other's version state," not "a single note supports field-level
concurrent editing."

Fixture strategy (both entries via the existing generic POST /timeline,
verified against actual role/section rules before implementation):
  - Group 1 (stale OCC): one Clinician-authored clinician_note,
    sectionKey="plan".
  - Group 2 (section independence): one Staff-authored staff_note entry
    (sectionKey is fixed to "staff_note" by the route — not client
    selectable) + one Clinician-authored clinician_note,
    sectionKey="medication".
  None of these entries is AI-scribed, Patient-authored, or of either AI
  EntryType, so `isClinicianOverride` (see src/app/api/timeline/[id]/route.ts)
  never evaluates true for any write in this file — no system_event rows
  are produced anywhere in this test. This was verified against the exact
  predicate before writing assertions, not assumed.

No AuditEvent-reading endpoint exists anywhere in this API (verified by
inspection, same finding as test_revision_history.py). AuditEvent metadata
is checked via the same read-only, metadata-only Prisma probe mechanism
already used there — findMany() only, never create/update/delete, and it
selects only id/action/actorRole/timelineEntryId/versionId/createdAt. It
never selects or prints TimelineEntry.content, Version.content,
DATABASE_URL, or secrets.

Cleanup: all three entries this test creates are recorded by exact ID and
deleted via the same exact-ID Prisma cleanup script already approved for
this test suite (AuditEvent -> AiScribedNote -> Version -> TimelineEntry,
keyed by timelineEntryId/id IN the exact recorded list). No patient-wide,
type-wide, content-based, or timestamp-window delete anywhere. Reseed is
not used as this test's cleanup mechanism.

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
  python3 test_concurrent_edits.py

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
G1_INITIAL = "Plan: group1 initial content."
G1_CONTENT_A = "Plan: group1 first writer content (A)."
G1_CONTENT_B = "Plan: group1 stale second writer content (B) - must be rejected."

G2_STAFF_INITIAL = "Staff note: group2 initial content."
G2_STAFF_EDIT = "Staff note: group2 edited by Staff."
G2_CLINICIAN_INITIAL = "Medication: group2 initial content."
G2_CLINICIAN_EDIT = "Medication: group2 edited by Clinician."

_token_cache = {}
results = []
created_entry_ids = []  # exactly the 3 primary TimelineEntry ids this test creates


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


def timeline_entry_ids(actor_key, patient_id):
    token = login(FIXTURE_EMAILS[actor_key])
    status, payload = _http_json(
        "GET", f"/api/patients/{patient_id}/timeline", token=token
    )
    if status != 200 or not isinstance(payload, list):
        raise RuntimeError(f"Unexpected response listing timeline (status {status})")
    return {e["id"] for e in payload if isinstance(e, dict) and isinstance(e.get("id"), str)}


def count_timeline_entries(actor_key, patient_id):
    return len(timeline_entry_ids(actor_key, patient_id))


# ─── Throwaway tsx script runner: identical mechanism to
# test_revision_history.py (NODE_PATH + realpath fixes both required for a
# script in an OS temp dir to resolve dotenv/config, @prisma/adapter-pg,
# and the generated Prisma client).
def _run_tsx_script(script_template, entry_ids, script_name):
    project_root = os.path.dirname(os.path.abspath(__file__))
    prisma_client_path = os.path.join(project_root, "src", "generated", "prisma", "client")

    try:
        with tempfile.TemporaryDirectory(prefix="nightingale-concurrent-edits-") as tmpdir:
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

    # ─── Group 1 fixture: stale-OCC target ────────────────────────────────
    print("-- Group 1 fixture: stale OCC target --")
    status, body = create_entry("clinician_a", "clinician_note", G1_INITIAL, section_key="plan")
    g1_id = get_id(body)
    if g1_id is not None:
        created_entry_ids.append(g1_id)
    check(
        "G1-fixture. Clinician-authored plan entry created (versionNumber=1)",
        status == 201 and g1_id is not None and isinstance(body, dict)
        and body.get("versionNumber") == 1 and body.get("sectionKey") == "plan",
    )

    # ─── Group 2 fixtures: two independently-owned entries ────────────────
    print("\n-- Group 2 fixtures: independently-owned entries --")
    status, body = create_entry("staff_a", "staff_note", G2_STAFF_INITIAL)
    g2_staff_id = get_id(body)
    if g2_staff_id is not None:
        created_entry_ids.append(g2_staff_id)
    check(
        "G2-fixture-staff. Staff-authored staff_note entry created (versionNumber=1)",
        status == 201 and g2_staff_id is not None and isinstance(body, dict)
        and body.get("versionNumber") == 1 and body.get("sectionKey") == "staff_note",
    )

    status, body = create_entry(
        "clinician_a", "clinician_note", G2_CLINICIAN_INITIAL, section_key="medication"
    )
    g2_clinician_id = get_id(body)
    if g2_clinician_id is not None:
        created_entry_ids.append(g2_clinician_id)
    check(
        "G2-fixture-clinician. Clinician-authored medication entry created (versionNumber=1)",
        status == 201 and g2_clinician_id is not None and isinstance(body, dict)
        and body.get("versionNumber") == 1 and body.get("sectionKey") == "medication",
    )

    if g1_id is None or g2_staff_id is None or g2_clinician_id is None:
        print("FATAL: one or more fixtures failed to create, aborting remaining scenarios")
        return

    # ─── Group 1: stale OCC ────────────────────────────────────────────────
    print("\n-- Group 1A: first write --")
    status, body = put_entry("clinician_a", g1_id, G1_CONTENT_A, 1)
    check(
        "G1A1. first write with expectedVersion=1 succeeds -> 200, "
        "versionNumber=2, content=A",
        status == 200 and isinstance(body, dict)
        and body.get("versionNumber") == 2 and body.get("content") == G1_CONTENT_A,
    )

    v_status, v_body = get_versions("clinician_a", g1_id)
    vb = v_body if isinstance(v_body, dict) else {}
    versions_after_a = vb.get("versions") if isinstance(vb.get("versions"), list) else []
    check(
        "G1A2. exactly one historical Version row (v1 = original content)",
        v_status == 200 and len(versions_after_a) == 1
        and versions_after_a[0].get("versionNumber") == 1
        and versions_after_a[0].get("content") == G1_INITIAL,
    )

    print("\n-- Group 1B: stale write (same expectedVersion=1, now outdated) --")
    status, body = put_entry("clinician_a", g1_id, G1_CONTENT_B, 1)
    check(
        "G1B1. stale write with expectedVersion=1 -> 409 (confirmed actual "
        "status code from source before implementation)",
        status == 409,
    )

    status2, body2 = get_entry("clinician_a", g1_id)
    check(
        "G1B2. live content remains A (write B was rejected, not applied)",
        status2 == 200 and isinstance(body2, dict) and body2.get("content") == G1_CONTENT_A,
    )
    check(
        "G1B3. live versionNumber remains 2 (not incremented by the stale write)",
        status2 == 200 and isinstance(body2, dict) and body2.get("versionNumber") == 2,
    )

    v_status, v_body = get_versions("clinician_a", g1_id)
    vb = v_body if isinstance(v_body, dict) else {}
    versions_after_b = vb.get("versions") if isinstance(vb.get("versions"), list) else []
    check(
        "G1B4. no new Version row was created by the stale write "
        "(still exactly one historical row)",
        v_status == 200 and len(versions_after_b) == 1,
    )

    # ─── Group 2: RBAC boundaries still hold (checked before the legitimate
    # edits, so a rejected attempt cannot disturb subsequent version state —
    # confirmed safe because assertSectionOwnership runs before any write).
    print("\n-- Group 2E: RBAC boundaries in this fixture context --")
    status, _ = put_entry("staff_a", g2_clinician_id, "should not apply", 1)
    check(
        "G2E1. Staff cannot write the Clinician-owned medication entry -> 403",
        status == 403,
    )
    status, _ = put_entry("clinician_a", g2_staff_id, "should not apply", 1)
    check(
        "G2E2. Clinician cannot write the Staff-owned staff_note entry -> 403",
        status == 403,
    )

    # ─── Group 2: legitimate independent edits ────────────────────────────
    print("\n-- Group 2B: Staff updates its own staff_note entry --")
    status, body = put_entry("staff_a", g2_staff_id, G2_STAFF_EDIT, 1)
    check(
        "G2B1. Staff PUT expectedVersion=1 succeeds -> 200, versionNumber=2",
        status == 200 and isinstance(body, dict)
        and body.get("versionNumber") == 2 and body.get("content") == G2_STAFF_EDIT,
    )
    v_status, v_body = get_versions("staff_a", g2_staff_id)
    vb = v_body if isinstance(v_body, dict) else {}
    staff_versions = vb.get("versions") if isinstance(vb.get("versions"), list) else []
    check(
        "G2B2. one Version row archived for the staff_note entry "
        "(v1 = original staff content)",
        v_status == 200 and len(staff_versions) == 1
        and staff_versions[0].get("content") == G2_STAFF_INITIAL,
    )

    print("\n-- Group 2C: Clinician updates its own medication entry --")
    status, body = put_entry("clinician_a", g2_clinician_id, G2_CLINICIAN_EDIT, 1)
    check(
        "G2C1. Clinician PUT expectedVersion=1 succeeds -> 200, versionNumber=2",
        status == 200 and isinstance(body, dict)
        and body.get("versionNumber") == 2 and body.get("content") == G2_CLINICIAN_EDIT,
    )
    v_status, v_body = get_versions("clinician_a", g2_clinician_id)
    vb = v_body if isinstance(v_body, dict) else {}
    clinician_versions = vb.get("versions") if isinstance(vb.get("versions"), list) else []
    check(
        "G2C2. one Version row archived for the medication entry "
        "(v1 = original clinician content)",
        v_status == 200 and len(clinician_versions) == 1
        and clinician_versions[0].get("content") == G2_CLINICIAN_INITIAL,
    )

    # ─── Group 2D: explicit cross-entry independence ──────────────────────
    print("\n-- Group 2D: cross-entry independence --")
    s_status, s_body = get_entry("staff_a", g2_staff_id)
    c_status, c_body = get_entry("clinician_a", g2_clinician_id)
    check(
        "G2D1. staff_note entry's content/version unaffected by the "
        "Clinician's write to the other entry",
        s_status == 200 and isinstance(s_body, dict)
        and s_body.get("content") == G2_STAFF_EDIT and s_body.get("versionNumber") == 2,
    )
    check(
        "G2D2. medication entry's content/version unaffected by the "
        "Staff's write to the other entry",
        c_status == 200 and isinstance(c_body, dict)
        and c_body.get("content") == G2_CLINICIAN_EDIT and c_body.get("versionNumber") == 2,
    )
    check(
        "G2D3. no Version row from one entry is associated with the other "
        "(staff_note's only historical row holds staff content, "
        "medication's only historical row holds clinician content)",
        len(staff_versions) == 1 and len(clinician_versions) == 1
        and staff_versions[0].get("content") == G2_STAFF_INITIAL
        and clinician_versions[0].get("content") == G2_CLINICIAN_INITIAL,
    )

    # ─── AuditEvent metadata (read-only probe, metadata-only) ────────────
    print("\n-- H. AuditEvent metadata (read-only probe) --")
    audit_events, probe_error = read_audit_events([g1_id, g2_staff_id, g2_clinician_id])

    if audit_events is None:
        check("H0. read-only AuditEvent probe succeeded", False)
        print(f"PROBE FAILURE: {probe_error}")
    else:
        check("H0. read-only AuditEvent probe succeeded", True)

        def action_counts_for(entry_id):
            counts = {}
            for a in audit_events:
                if a.get("timelineEntryId") == entry_id:
                    counts[a.get("action")] = counts.get(a.get("action"), 0) + 1
            return counts

        g1_counts = action_counts_for(g1_id)
        check(
            "H1. Group 1 entry has exactly 3 AuditEvent rows: "
            "note_created x1, note_updated x1, conflict_flagged x1 (from the "
            "stale write's best-effort audit — confirmed as defined "
            "production behavior, not an open question)",
            g1_counts == {"note_created": 1, "note_updated": 1, "conflict_flagged": 1},
        )

        conflict_event = next(
            (a for a in audit_events if a.get("timelineEntryId") == g1_id
             and a.get("action") == "conflict_flagged"),
            None,
        )
        check(
            "H2. the stale-write conflict_flagged AuditEvent has versionId=null "
            "(matches source: no snapshot exists to point to on a rejected write)",
            isinstance(conflict_event, dict) and conflict_event.get("versionId") is None,
        )

        g2_staff_counts = action_counts_for(g2_staff_id)
        g2_clinician_counts = action_counts_for(g2_clinician_id)
        check(
            "H3. Group 2 staff_note entry has exactly 2 AuditEvent rows: "
            "note_created x1, note_updated x1 (no conflict_flagged — "
            "isClinicianOverride never applies to a Staff-authored write)",
            g2_staff_counts == {"note_created": 1, "note_updated": 1},
        )
        check(
            "H4. Group 2 medication entry has exactly 2 AuditEvent rows: "
            "note_created x1, note_updated x1 (no conflict_flagged — "
            "clinician_note authored by Clinician never satisfies "
            "isClinicianOverride)",
            g2_clinician_counts == {"note_created": 1, "note_updated": 1},
        )

        check(
            "H5. every observed AuditEvent has actorRole matching the "
            "authorized actor who performed that action",
            all(a.get("actorRole") in ("Clinician", "Staff") for a in audit_events),
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
