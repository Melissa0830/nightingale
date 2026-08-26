"""
test_rbac_scope.py

Micro-test: server-side RBAC enforcement (role / clinic / patient scope).

Black-box HTTP test against a running Next.js dev server. Does NOT import
or call any server-side RBAC helper directly — every case goes through the
real API, and every auth token is obtained via POST /api/auth/login using
synthetic fixture emails from prisma/seed.ts (never hand-signed).

目前 RBAC microtest 所需的 implementation endpoints 全部存在:
  POST /api/auth/login
  GET  /api/auth/me
  GET  /api/patients/:id
  GET  /api/timeline/:id
  PUT  /api/timeline/:id
  GET  /api/timeline/:id/comments
  POST /api/patients/:id/ai-scribe (fixture setup only, see AI-scribed notes section)

Prerequisites:
  1. Database seeded with the fixed synthetic fixtures:
       npx tsx prisma/seed.ts
  2. Next.js dev server running:
       npm run dev
     (defaults to http://localhost:3000; override with NIGHTINGALE_BASE_URL)
  3. `npx tsx` available (already a devDependency of this project) — needed
     only for cleanup of the AI Scribe fixture below, not for the RBAC
     assertions themselves.

AI Scribe fixture cleanup: this file creates exactly one AI Scribe
TimelineEntry (ai_patient_session_summary — there is no fixed seed.ts
fixture for that type) to exercise Patient-visibility RBAC on it. That
entry's id is recorded and deleted (along with its AiScribedNote/AuditEvent/
any Version row) in a `finally` block, via the same throwaway-Prisma-script
mechanism as test_ai_scribe_ingestion.py — see that file's module docstring
for the full design rationale (no DELETE endpoint exists in this API).

WARNING: this file performs ONE real write that still mutates the synthetic
baseline and is NOT cleaned up: the last test case (Clinician A editing the
"plan" section it owns — see comment above that case for exactly what
changes: versionNumber 1->2, one new Version row, one new AuditEvent). This
is an in-place edit of a pre-existing seed row, not a creatable/deletable
fixture, so it is out of scope for the delete-by-id cleanup used for the AI
Scribe fixture above. Re-run `npx tsx prisma/seed.ts` after this script
finishes to restore it.

Usage:
  python test_rbac_scope.py

Exit code: 0 if all cases pass AND AI Scribe fixture cleanup succeeds, 1 otherwise.
"""

import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

BASE_URL = os.environ.get("NIGHTINGALE_BASE_URL", "http://localhost:3000").rstrip("/")

# ─── Synthetic fixture identifiers (must match prisma/seed.ts) ────────────
FIXTURE_EMAILS = {
    "patient_a": "patient.a@clinic-a.test",
    "staff_a": "staff.a@clinic-a.test",
    "clinician_a": "clinician.a@clinic-a.test",
    "admin_a": "admin.a@clinic-a.test",
    "clinician_b": "clinician.b@clinic-b.test",
}

PATIENT_A_ID = "synthetic-patient-a"
PATIENT_B_ID = "synthetic-patient-b"
ENTRY_PATIENT_SUMMARY_ID = "synthetic-entry-patient-summary"  # patient-visible
ENTRY_STAFF_NOTE_ID = "synthetic-entry-staff-note"            # sectionKey=staff_note
ENTRY_PLAN_ID = "synthetic-entry-plan"                        # sectionKey=plan, has comments
ENTRY_AI_DOCTOR_SUMMARY_ID = "synthetic-entry-ai-doctor-summary"  # type=ai_doctor_consult_summary

_token_cache = {}


def _http(method, path, token=None, body=None):
    """Issue one HTTP request and return its status code. Never returns or
    logs the response body — callers that need it must read it explicitly."""
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
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Cannot reach {BASE_URL} — is the Next.js dev server running? ({e.reason})"
        ) from e


def _http_json(method, path, token=None, body=None):
    """Like _http, but also returns the parsed JSON body. Used ONLY to read
    back the id of an entry this script creates for its own fixture setup
    below (ai_patient_session_summary has no fixed seed.ts fixture) — every
    RBAC assertion itself still goes through run_case/_http and checks only
    the status code, never the body."""
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
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, None


# ─── AI Scribe fixture cleanup: throwaway Prisma script via tsx ───────────
# Same mechanism/rationale as test_ai_scribe_ingestion.py (no DELETE
# endpoint exists anywhere in this API). Deletes ONLY the exact id of the
# ai_patient_session_summary fixture this run creates below — never a
# patient-wide or content-based delete, and never the PUT-write mutation on
# the pre-existing "plan" seed row (see module docstring WARNING).
created_entry_ids = []

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


def cleanup(entry_ids):
    """Deletes exactly `entry_ids` (+ their AiScribedNote/AuditEvent/Version
    rows) via a temp Prisma script written to the OS temp directory and
    removed immediately after running. Returns
    (ok, counts_or_None, error_or_None). Never raises — safe to call from a
    `finally` block."""
    project_root = os.path.dirname(os.path.abspath(__file__))
    prisma_client_path = os.path.join(
        project_root, "src", "generated", "prisma", "client"
    )

    try:
        with tempfile.TemporaryDirectory(prefix="nightingale-rbac-cleanup-") as tmpdir:
            script_path = os.path.join(tmpdir, "cleanup.ts")
            # realpath both sides: on macOS, tempfile reports paths under
            # /var/... but the filesystem's canonical location is
            # /private/var/... (symlink) — Node resolves the running
            # script's OWN path to the canonical form, so a relative import
            # computed against the non-canonical tmpdir string is off by
            # one directory level and fails to resolve.
            rel_import = os.path.relpath(
                os.path.realpath(prisma_client_path), start=os.path.realpath(tmpdir)
            ).replace(os.sep, "/")
            if not rel_import.startswith("."):
                rel_import = "./" + rel_import
            script_content = CLEANUP_SCRIPT_TEMPLATE.replace(
                "__PRISMA_CLIENT_IMPORT__", rel_import
            ).replace("__ENTRY_IDS_JSON__", json.dumps(entry_ids))
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(script_content)

            # NODE_PATH is required: Node resolves bare specifiers
            # (dotenv/config, @prisma/adapter-pg) by walking up from the
            # IMPORTING FILE's own directory, not from cwd — a script in an
            # OS temp dir has no project node_modules in its ancestor chain
            # otherwise.
            env = {**os.environ, "NODE_PATH": os.path.join(project_root, "node_modules")}
            proc = subprocess.run(
                ["npx", "tsx", script_path],
                cwd=project_root,
                capture_output=True,
                text=True,
                timeout=60,
                env=env,
            )
            # tmpdir (and script_path) is removed here on context-manager
            # exit, whether the subprocess succeeded, failed, or timed out.
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, None, f"cleanup subprocess failed to run: {type(e).__name__}"

    stdout_lines = (proc.stdout or "").strip().splitlines()
    last_line = stdout_lines[-1] if stdout_lines else ""
    try:
        payload = json.loads(last_line) if last_line else None
    except json.JSONDecodeError:
        payload = None

    if proc.returncode != 0 or not isinstance(payload, dict) or not payload.get("ok"):
        code = payload.get("code") if isinstance(payload, dict) else None
        return False, payload, f"cleanup script exited {proc.returncode} (code={code})"

    return True, payload, None


def login(email):
    """Exchange a synthetic fixture email for a real JWT via the login API.
    Never hand-signs a token, never fills role/clinicId/patientId locally."""
    if email in _token_cache:
        return _token_cache[email]

    url = f"{BASE_URL}/api/auth/login"
    data = json.dumps({"email": email}).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"Login failed for fixture user (status {e.code}); "
            "check that the database has been seeded"
        ) from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Cannot reach {BASE_URL} — is the Next.js dev server running? ({e.reason})"
        ) from e

    token = payload.get("token")
    if not token:
        raise RuntimeError("Login response did not contain a token")
    _token_cache[email] = token
    return token


results = []


def record(name, condition):
    """Like run_case, but for a plain boolean check (used by the cleanup
    report below, which has no expected-HTTP-status shape)."""
    results.append(bool(condition))
    label = "PASS" if condition else "FAIL"
    print(f"[{label}] {name}")


def count_timeline_entries(actor_key, patient_id):
    token = login(FIXTURE_EMAILS[actor_key])
    status, payload = _http_json(
        "GET", f"/api/patients/{patient_id}/timeline", token=token
    )
    if status != 200 or not isinstance(payload, list):
        raise RuntimeError(f"Unexpected response listing timeline (status {status})")
    return len(payload)


def run_case(name, method, path, expected_status, actor=None, token_override=None, body=None):
    """actor: key into FIXTURE_EMAILS, logged in via the real login API.
    token_override: a raw string used as-is (only for the invalid-token case).
    Neither the token nor any response body is ever printed."""
    if token_override is not None:
        token = token_override
    elif actor is not None:
        token = login(FIXTURE_EMAILS[actor])
    else:
        token = None

    actual_status = _http(method, path, token=token, body=body)
    passed = actual_status == expected_status
    results.append(passed)
    label = "PASS" if passed else "FAIL"
    print(f"[{label}] {name} | expected={expected_status} actual={actual_status}")


def main():
    print(f"Target: {BASE_URL}\n")

    # ─── Authentication ────────────────────────────────────────────────
    print("-- Authentication --")
    run_case("missing token -> 401", "GET", "/api/auth/me", 401)
    run_case(
        "invalid token -> 401", "GET", "/api/auth/me", 401,
        token_override="this-is-not-a-valid-jwt",
    )

    # ─── GET /api/patients/:id ─────────────────────────────────────────
    print("\n-- GET /api/patients/:id --")
    run_case("Patient A -> Patient A = 200", "GET", f"/api/patients/{PATIENT_A_ID}", 200, actor="patient_a")
    run_case("Patient A -> Patient B = 403", "GET", f"/api/patients/{PATIENT_B_ID}", 403, actor="patient_a")
    run_case("Staff A -> Patient A = 200", "GET", f"/api/patients/{PATIENT_A_ID}", 200, actor="staff_a")
    run_case("Clinician A -> Patient A = 200", "GET", f"/api/patients/{PATIENT_A_ID}", 200, actor="clinician_a")
    run_case("Admin A -> Patient A = 200", "GET", f"/api/patients/{PATIENT_A_ID}", 200, actor="admin_a")
    run_case("Admin A -> Patient B = 403", "GET", f"/api/patients/{PATIENT_B_ID}", 403, actor="admin_a")
    run_case("Clinician B -> Patient A = 403", "GET", f"/api/patients/{PATIENT_A_ID}", 403, actor="clinician_b")

    # ─── GET /api/timeline/:id ─────────────────────────────────────────
    print("\n-- GET /api/timeline/:id --")
    run_case(
        "Patient A -> patient_session_summary = 200", "GET",
        f"/api/timeline/{ENTRY_PATIENT_SUMMARY_ID}", 200, actor="patient_a",
    )
    run_case(
        "Patient A -> staff_note = 404", "GET",
        f"/api/timeline/{ENTRY_STAFF_NOTE_ID}", 404, actor="patient_a",
    )
    run_case(
        "Patient A -> clinician plan = 404", "GET",
        f"/api/timeline/{ENTRY_PLAN_ID}", 404, actor="patient_a",
    )
    run_case(
        "Staff A -> same-clinic internal = 200", "GET",
        f"/api/timeline/{ENTRY_PLAN_ID}", 200, actor="staff_a",
    )
    run_case(
        "Clinician A -> same-clinic internal = 200", "GET",
        f"/api/timeline/{ENTRY_PLAN_ID}", 200, actor="clinician_a",
    )
    run_case(
        "Admin A -> same-clinic internal = 200", "GET",
        f"/api/timeline/{ENTRY_PLAN_ID}", 200, actor="admin_a",
    )
    run_case(
        "Clinician B -> Clinic A entry = 403", "GET",
        f"/api/timeline/{ENTRY_PLAN_ID}", 403, actor="clinician_b",
    )

    # ─── GET /api/timeline/:id — raw AI-scribed notes (Patient visibility) ──
    # Required by requirements.md Day-1 completion criteria: "Patient
    # accesses raw AI-scribed notes -> 403". ai_doctor_consult_summary has a
    # fixed seed.ts fixture; ai_patient_session_summary does not, so one is
    # created here via the real AI Scribe endpoint (self-contained — no
    # seed.ts change needed just to exercise this RBAC case).
    print("\n-- GET /api/timeline/:id (raw AI-scribed notes) --")
    run_case(
        "Patient A -> ai_doctor_consult_summary = 404", "GET",
        f"/api/timeline/{ENTRY_AI_DOCTOR_SUMMARY_ID}", 404, actor="patient_a",
    )
    run_case(
        "Staff A -> ai_doctor_consult_summary = 200", "GET",
        f"/api/timeline/{ENTRY_AI_DOCTOR_SUMMARY_ID}", 200, actor="staff_a",
    )

    _, ai_patient_entry = _http_json(
        "POST", f"/api/patients/{PATIENT_A_ID}/ai-scribe",
        token=login(FIXTURE_EMAILS["staff_a"]),
        body={
            "sessionType": "patient_session",
            "sessionId": "rbac-scope-fixture-patient-session",
            "rawText": "Routine AI-patient session note for RBAC fixture setup.",
        },
    )
    if not ai_patient_entry or "id" not in ai_patient_entry:
        raise RuntimeError(
            "Failed to create ai_patient_session_summary fixture via AI Scribe endpoint"
        )
    ai_patient_entry_id = ai_patient_entry["id"]
    created_entry_ids.append(ai_patient_entry_id)

    run_case(
        "Patient A -> ai_patient_session_summary = 404", "GET",
        f"/api/timeline/{ai_patient_entry_id}", 404, actor="patient_a",
    )
    run_case(
        "Staff A -> ai_patient_session_summary = 200", "GET",
        f"/api/timeline/{ai_patient_entry_id}", 200, actor="staff_a",
    )

    # ─── GET /api/timeline/:id/comments ────────────────────────────────
    print("\n-- GET /api/timeline/:id/comments --")
    run_case("Patient A = 403", "GET", f"/api/timeline/{ENTRY_PLAN_ID}/comments", 403, actor="patient_a")
    run_case("Staff A = 200", "GET", f"/api/timeline/{ENTRY_PLAN_ID}/comments", 200, actor="staff_a")
    run_case("Clinician A = 200", "GET", f"/api/timeline/{ENTRY_PLAN_ID}/comments", 200, actor="clinician_a")
    run_case("Admin A = 200", "GET", f"/api/timeline/{ENTRY_PLAN_ID}/comments", 200, actor="admin_a")
    run_case("Clinician B = 403", "GET", f"/api/timeline/{ENTRY_PLAN_ID}/comments", 403, actor="clinician_b")

    # ─── PUT /api/timeline/:id (rejection cases only, no successful write) ──
    print("\n-- PUT /api/timeline/:id (rejection cases only) --")
    probe_body = {"content": "rbac-probe (expected to be rejected)", "expectedVersion": 1}
    run_case(
        "Patient -> 403", "PUT", f"/api/timeline/{ENTRY_PLAN_ID}", 403,
        actor="patient_a", body=probe_body,
    )
    run_case(
        "Admin -> 403", "PUT", f"/api/timeline/{ENTRY_PLAN_ID}", 403,
        actor="admin_a", body=probe_body,
    )
    run_case(
        "Staff A modifies plan -> 403", "PUT", f"/api/timeline/{ENTRY_PLAN_ID}", 403,
        actor="staff_a", body=probe_body,
    )
    run_case(
        "Clinician A modifies staff_note -> 403", "PUT", f"/api/timeline/{ENTRY_STAFF_NOTE_ID}", 403,
        actor="clinician_a", body=probe_body,
    )
    run_case(
        "Clinician B modifies Clinic A entry -> 403", "PUT", f"/api/timeline/{ENTRY_PLAN_ID}", 403,
        actor="clinician_b", body=probe_body,
    )

    # ─── PUT /api/timeline/:id (one legitimate write, run LAST) ─────────
    # Confirmed against src/app/api/timeline/[id]/route.ts before writing this case:
    #   - success status is 200 (Response.json(updatedEntry) has no status override)
    #   - request body only needs {content, expectedVersion}; sectionKey/type/
    #     authorRole are read from the DB row, never from the request body
    #   - section ownership is checked against DB TimelineEntry.sectionKey
    #     ("plan" -> Clinician), not anything client-supplied
    #
    # This call WILL mutate the synthetic baseline:
    #   - TimelineEntry(synthetic-entry-plan).versionNumber: 1 -> 2
    #   - 1 new Version row created (snapshot of the pre-update content)
    #   - 1 new AuditEvent row created, action = note_updated
    #   - NO conflict_flagged AuditEvent — entry.type is clinician_note and
    #     entry.authorRole is Clinician (not AI/system/Patient), so the
    #     isClinicianOverride condition in the route is false for this entry
    # (baseline reset is not this script's job — see module docstring WARNING)
    print("\n-- PUT /api/timeline/:id (legitimate write) --")
    run_case(
        "Clinician A modifies plan (owns section) -> 200", "PUT",
        f"/api/timeline/{ENTRY_PLAN_ID}", 200,
        actor="clinician_a",
        body={
            "content": "Plan updated by Clinician A (rbac_scope legitimate-write case)",
            "expectedVersion": 1,
        },
    )

if __name__ == "__main__":
    baseline_count = None
    try:
        baseline_count = count_timeline_entries("staff_a", PATIENT_A_ID)
    except RuntimeError as exc:
        print(f"[ERROR] establishing baseline: {exc}")
        results.append(False)

    try:
        main()
    except RuntimeError as exc:
        print(f"[ERROR] {exc}")
        results.append(False)
    finally:
        cleanup_ok, cleanup_counts, cleanup_error = cleanup(created_entry_ids)

    print("\n-- AI Scribe fixture cleanup --")
    if cleanup_ok:
        expected = len(created_entry_ids)
        counts_match = (
            isinstance(cleanup_counts, dict)
            and cleanup_counts.get("deletedTimelineEntries") == expected
            and cleanup_counts.get("deletedAiScribedNotes") == expected
            and cleanup_counts.get("deletedAuditEvents") == expected
        )
        record("cleanup. temp Prisma cleanup script succeeded", True)
        record("cleanup. deleted counts match created count", counts_match)
    else:
        record("cleanup. temp Prisma cleanup script succeeded", False)
        print(f"CLEANUP FAILURE: {cleanup_error}")

    if baseline_count is not None:
        try:
            final_count = count_timeline_entries("staff_a", PATIENT_A_ID)
            record(
                "cleanup. TimelineEntry count restored to pre-run baseline",
                final_count == baseline_count,
            )
        except RuntimeError as exc:
            record("cleanup. TimelineEntry count restored to pre-run baseline", False)
            print(f"[ERROR] verifying post-cleanup baseline: {exc}")
    else:
        record("cleanup. TimelineEntry count restored to pre-run baseline", False)

    # ─── Summary ────────────────────────────────────────────────────────
    total = len(results)
    passed = sum(results)
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if (passed == total and cleanup_ok) else 1)
