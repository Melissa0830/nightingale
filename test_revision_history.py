"""
test_revision_history.py

Micro-test: Version snapshot invariant, OCC-driven revision creation, and
revert behavior, exercised against a temporary Clinician-authored
TimelineEntry.

Black-box HTTP test against a running Next.js dev server — same convention
as test_ai_scribe_ingestion.py / test_rbac_scope.py. Auth tokens are
obtained via POST /api/auth/login using synthetic fixture emails from
prisma/seed.ts (never hand-signed).

Fixture choice (deliberate, verified before implementation):
  This test creates its fixture via the generic POST /api/timeline as a
  same-clinic Clinician: type=clinician_note, sectionKey="summary"
  (Clinician-owned per src/lib/auth/section-ownership.ts). This makes
  authorRole="Clinician" and type="clinician_note" on the created entry.

  Both the PUT and revert routes compute:
    isClinicianOverride = user.role === "Clinician" &&
      (entry.type in {ai_doctor_consult_summary, ai_nurse_consult_summary}
       || entry.authorRole === Patient || entry.authorRole === system)
  For THIS fixture, entry.type is "clinician_note" and entry.authorRole is
  "Clinician" — none of the four disjuncts hold, so isClinicianOverride is
  false on every write. Verified directly (not assumed) with the exact
  predicate before writing this file. This keeps the test single-purpose:
  it exercises only the plain revision-history path (note_updated /
  note_reverted, ordinary revert system_event), not the separate
  Clinician-overrides-AI/patient-content conflict path, which belongs to
  conflict/RBAC coverage, not here.

  An earlier draft of this file used an AI-Scribe-created entry
  (authorRole=system) instead. That fixture unconditionally triggers
  isClinicianOverride on every Clinician write (authorRole=system never
  changes), entangling plain revision-history behavior with conflict
  behavior on every step. That draft was discarded before implementation
  in favor of this one, specifically to keep this test single-purpose.

No AuditEvent-reading endpoint exists anywhere in this API (verified by
inspection). To assert AuditEvent metadata, this file uses a read-only
Prisma probe — the same throwaway-tsx-script mechanism already used by this
test suite's cleanup() functions, but running findMany() instead of
deleteMany(), and metadata-only: it selects and returns ONLY
AuditEvent.id / action / actorRole / timelineEntryId / versionId /
createdAt. It never selects or returns TimelineEntry.content or
Version.content, never prints DATABASE_URL or secrets. Version.content and
versionNumber are verified through the existing
GET /api/timeline/:id/versions endpoint instead, which already exposes
them — no probe needed for Version data.

Cleanup: the primary fixture AND the single system_event row the revert
step produces are recorded by exact ID (the system_event id is discovered
via a before/after diff of GET /api/patients/:id/timeline around the revert
call — the revert response body does not expose it) and deleted via the
same exact-ID Prisma cleanup script already approved for this test suite
(AuditEvent -> AiScribedNote -> Version -> TimelineEntry, all keyed by
timelineEntryId/id IN the exact recorded list). No patient-wide, type-wide,
content-based, or timestamp-window delete anywhere.

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
  python3 test_revision_history.py

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
    "clinician_a": "clinician.a@clinic-a.test",
}
PATIENT_A_ID = "synthetic-patient-a"

# Plain, non-PHI clinical text for each write, kept distinguishable so
# content-equality assertions unambiguously identify which snapshot is which.
FIXTURE_CONTENT = "Plan: initial version recorded for revision-history test."
FIRST_EDIT_CONTENT = "Plan: revised after first edit."
SECOND_EDIT_CONTENT = "Plan: revised after second edit."

_token_cache = {}
results = []
created_entry_ids = []  # primary fixture id + the single revert system_event id


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


def create_clinician_entry(actor_key, content, section_key):
    token = login(FIXTURE_EMAILS[actor_key])
    return _http_json(
        "POST",
        "/api/timeline",
        token=token,
        body={
            "content": content,
            "patientId": PATIENT_A_ID,
            "type": "clinician_note",
            "sectionKey": section_key,
        },
    )


def put_entry(actor_key, entry_id, content, expected_version):
    token = login(FIXTURE_EMAILS[actor_key])
    return _http_json(
        "PUT",
        f"/api/timeline/{entry_id}",
        token=token,
        body={"content": content, "expectedVersion": expected_version},
    )


def revert_entry(actor_key, entry_id, target_version, expected_version):
    token = login(FIXTURE_EMAILS[actor_key])
    return _http_json(
        "POST",
        f"/api/timeline/{entry_id}/revert",
        token=token,
        body={"targetVersion": target_version, "expectedVersion": expected_version},
    )


def get_versions(actor_key, entry_id):
    token = login(FIXTURE_EMAILS[actor_key])
    return _http_json("GET", f"/api/timeline/{entry_id}/versions", token=token)


def get_entry(actor_key, entry_id):
    token = login(FIXTURE_EMAILS[actor_key])
    return _http_json("GET", f"/api/timeline/{entry_id}", token=token)


def timeline_entry_ids(actor_key, patient_id):
    """Returns {id: type} for every entry currently on the patient's
    timeline — used to diff before/after revert and discover the
    system_event id it produces (the revert response does not expose it)."""
    token = login(FIXTURE_EMAILS[actor_key])
    status, payload = _http_json(
        "GET", f"/api/patients/{patient_id}/timeline", token=token
    )
    if status != 200 or not isinstance(payload, list):
        raise RuntimeError(f"Unexpected response listing timeline (status {status})")
    result = {}
    for e in payload:
        if isinstance(e, dict) and isinstance(e.get("id"), str):
            result[e["id"]] = e.get("type")
    return result


def count_timeline_entries(actor_key, patient_id):
    return len(timeline_entry_ids(actor_key, patient_id))


def diff_new_system_events(before_ids, after_ids):
    new_ids = [i for i in after_ids if i not in before_ids]
    return [i for i in new_ids if after_ids.get(i) == "system_event"]


# ─── Throwaway tsx script runner: shared by the delete (cleanup) and the
# read-only (AuditEvent probe) scripts. NODE_PATH + realpath fixes are both
# required for a script in an OS temp dir to resolve dotenv/config,
# @prisma/adapter-pg, and the generated Prisma client (verified necessary
# in an earlier round of this test suite's cleanup mechanism).
def _run_tsx_script(script_template, entry_ids, script_name):
    project_root = os.path.dirname(os.path.abspath(__file__))
    prisma_client_path = os.path.join(project_root, "src", "generated", "prisma", "client")

    try:
        with tempfile.TemporaryDirectory(prefix="nightingale-revision-history-") as tmpdir:
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

# Read-only, metadata-only: AuditEvent fields only. Never selects
# TimelineEntry.content or Version.content. No create/update/delete calls.
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
    """Read-only, metadata-only. Returns (auditEvents, error) — [] (not
    None) on success with no matching rows; (None, error) if the probe
    itself failed to run."""
    ok, payload, error = _run_tsx_script(READ_PROBE_SCRIPT_TEMPLATE, entry_ids, "probe.ts")
    if not ok or not isinstance(payload, dict):
        return None, error
    audit_events = payload.get("auditEvents")
    if not isinstance(audit_events, list):
        return None, "probe returned malformed payload"
    return audit_events, None


def run_tests():
    print(f"Target: {BASE_URL}\n")

    # ─── Fixture: Clinician-authored clinician_note, sectionKey=summary ──
    print("-- Fixture setup --")
    status, body = create_clinician_entry("clinician_a", FIXTURE_CONTENT, "summary")
    entry_id = get_id(body)
    if entry_id is not None:
        created_entry_ids.append(entry_id)
    initial_content = body.get("content") if isinstance(body, dict) else None
    check(
        "fixture. Clinician-authored entry created with expected shape "
        "(authorRole=Clinician, sectionKey=summary, versionNumber=1)",
        status == 201
        and entry_id is not None
        and isinstance(body, dict)
        and body.get("authorRole") == "Clinician"
        and body.get("sectionKey") == "summary"
        and body.get("versionNumber") == 1,
    )

    if entry_id is None:
        print("FATAL: fixture creation failed, aborting remaining scenarios")
        return

    # ─── A. Initial state ────────────────────────────────────────────────
    print("\n-- A. Initial state --")
    v_status, v_body = get_versions("clinician_a", entry_id)
    vb = v_body if isinstance(v_body, dict) else {}
    check(
        "A1. live versionNumber = 1, no historical Version rows",
        v_status == 200 and vb.get("currentVersionNumber") == 1 and vb.get("versions") == [],
    )

    # ─── B. First successful edit ────────────────────────────────────────
    print("\n-- B. First successful edit --")
    status, body = put_entry("clinician_a", entry_id, FIRST_EDIT_CONTENT, 1)
    check(
        "B1. PUT expectedVersion=1 succeeds -> 200, versionNumber=2, content updated",
        status == 200
        and isinstance(body, dict)
        and body.get("versionNumber") == 2
        and body.get("content") == FIRST_EDIT_CONTENT,
    )

    v_status, v_body = get_versions("clinician_a", entry_id)
    vb = v_body if isinstance(v_body, dict) else {}
    versions_after_b = vb.get("versions") if isinstance(vb.get("versions"), list) else []
    v1_row = versions_after_b[0] if len(versions_after_b) == 1 else None
    check(
        "B2. exactly one historical Version row exists, versionNumber=1, "
        "content equals pre-edit v1 content",
        v_status == 200
        and len(versions_after_b) == 1
        and isinstance(v1_row, dict)
        and v1_row.get("versionNumber") == 1
        and v1_row.get("content") == initial_content,
    )
    v1_version_row_id = v1_row.get("id") if isinstance(v1_row, dict) else None

    # ─── C. Second successful edit ───────────────────────────────────────
    print("\n-- C. Second successful edit --")
    status, body = put_entry("clinician_a", entry_id, SECOND_EDIT_CONTENT, 2)
    check(
        "C1. PUT expectedVersion=2 succeeds -> 200, versionNumber=3, content updated",
        status == 200
        and isinstance(body, dict)
        and body.get("versionNumber") == 3
        and body.get("content") == SECOND_EDIT_CONTENT,
    )

    v_status, v_body = get_versions("clinician_a", entry_id)
    vb = v_body if isinstance(v_body, dict) else {}
    versions_after_c = vb.get("versions") if isinstance(vb.get("versions"), list) else []
    v2_row = next(
        (r for r in versions_after_c if isinstance(r, dict) and r.get("versionNumber") == 2),
        None,
    )
    check(
        "C2. exactly two historical Version rows now (v1 untouched, v2 added); "
        "live v3 is NOT duplicated into the Version table",
        v_status == 200
        and len(versions_after_c) == 2
        and isinstance(v2_row, dict)
        and v2_row.get("content") == FIRST_EDIT_CONTENT,
    )

    # ─── D. Revert to version 1 ───────────────────────────────────────────
    print("\n-- D. Revert to version 1 --")
    known_ids = timeline_entry_ids("clinician_a", PATIENT_A_ID)
    status, body = revert_entry("clinician_a", entry_id, 1, 3)
    check(
        "D1. revert to v1 succeeds -> 200, content restored, versionNumber=4 "
        "(monotonic increase, not rewound to 1)",
        status == 200
        and isinstance(body, dict)
        and body.get("content") == initial_content
        and body.get("versionNumber") == 4,
    )

    after_d_ids = timeline_entry_ids("clinician_a", PATIENT_A_ID)
    new_system_events = diff_new_system_events(known_ids, after_d_ids)
    created_entry_ids.extend(new_system_events)
    check(
        "D2. exactly ONE system_event created by revert "
        "(the plain 'reverted' event only — no conflict override, "
        "since this fixture is Clinician-authored clinician_note)",
        len(new_system_events) == 1,
    )
    revert_event_id = new_system_events[0] if len(new_system_events) == 1 else None

    v_status, v_body = get_versions("clinician_a", entry_id)
    vb = v_body if isinstance(v_body, dict) else {}
    versions_after_d = vb.get("versions") if isinstance(vb.get("versions"), list) else []
    v3_row = next(
        (r for r in versions_after_d if isinstance(r, dict) and r.get("versionNumber") == 3),
        None,
    )
    check(
        "D3. pre-revert live state (v3) archived as a new historical Version row",
        v_status == 200
        and len(versions_after_d) == 3
        and isinstance(v3_row, dict)
        and v3_row.get("content") == SECOND_EDIT_CONTENT,
    )

    if revert_event_id is not None:
        s_status, s_body = get_entry("clinician_a", revert_event_id)
        s_content = s_body.get("content", "") if isinstance(s_body, dict) else ""
        check(
            "D4. the revert system_event's own content mentions 'reverted' "
            "(not a conflict-flagged label)",
            s_status == 200
            and "reverted" in s_content.lower()
            and "conflict" not in s_content.lower(),
        )
    else:
        check("D4. the revert system_event's own content mentions 'reverted'", False)

    # ─── F. AuditEvent metadata (read-only probe, metadata-only) ─────────
    print("\n-- F. AuditEvent metadata (read-only probe) --")
    probe_ids = [entry_id] + ([revert_event_id] if revert_event_id else [])
    audit_events, probe_error = read_audit_events(probe_ids)

    if audit_events is None:
        check("F0. read-only AuditEvent probe succeeded", False)
        print(f"PROBE FAILURE: {probe_error}")
    else:
        check("F0. read-only AuditEvent probe succeeded", True)

        entry_audit = [a for a in audit_events if a.get("timelineEntryId") == entry_id]
        system_event_audit = (
            [a for a in audit_events if a.get("timelineEntryId") == revert_event_id]
            if revert_event_id
            else []
        )

        action_counts = {}
        for a in entry_audit:
            action_counts[a.get("action")] = action_counts.get(a.get("action"), 0) + 1

        # Hard expectation per design: conflict_flagged must be absent. If it
        # appears, this is an unexpected result to investigate, not to work
        # around — the assertion is written so a regression shows as a clear
        # FAIL rather than being silently tolerated.
        check(
            "F1. primary entry has exactly 4 AuditEvent rows: "
            "note_created x1, note_updated x2, note_reverted x1, "
            "conflict_flagged x0 (closed set)",
            len(entry_audit) == 4
            and action_counts
            == {"note_created": 1, "note_updated": 2, "note_reverted": 1},
        )

        check(
            "F2. every AuditEvent on the primary entry has actorRole=Clinician",
            all(a.get("actorRole") == "Clinician" for a in entry_audit),
        )

        reverted_event = next((a for a in entry_audit if a.get("action") == "note_reverted"), None)
        check(
            "F3. note_reverted AuditEvent.versionId points to the archived v1 Version row",
            isinstance(reverted_event, dict)
            and v1_version_row_id is not None
            and reverted_event.get("versionId") == v1_version_row_id,
        )

        check(
            "F4. the revert system_event row has NO AuditEvent of its own",
            len(system_event_audit) == 0,
        )

    # ─── Failure/robustness sanity: unknown entry id behaves safely ──────
    print("\n-- G. Defensive behavior --")
    status, _ = get_versions("clinician_a", "nonexistent-entry-id-xyz")
    check("G1. GET versions for a nonexistent entry -> 404, no crash", status == 404)


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
