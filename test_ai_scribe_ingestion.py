"""
test_ai_scribe_ingestion.py

Micro-test: AI Scribe ingestion endpoint (POST /api/patients/:id/ai-scribe),
PHI redaction, session-type mapping, and RBAC on the ingestion path.

Black-box HTTP test against a running Next.js dev server — same convention
as test_rbac_scope.py. All assertions go through the real API; no server-side
helper is imported directly and no DB driver is used for the assertions
themselves.

The ONE exception is cleanup (see below): since this repo has no DELETE
endpoint anywhere in the API, cleanup shells out to a throwaway Prisma
script run through the project's existing `tsx` toolchain (the same
mechanism `prisma/seed.ts` already uses) rather than adding a new
dependency, a new route, or a raw SQL client.

Prerequisites:
  1. Database seeded with the fixed synthetic fixtures:
       npx tsx prisma/seed.ts
  2. Next.js dev server running:
       npm run dev
     (defaults to http://localhost:3000; override with NIGHTINGALE_BASE_URL)
  3. `npx tsx` available (already a devDependency of this project) — needed
     only for cleanup, not for the HTTP assertions themselves.

Cleanup design:
  - Every successful (201) ingestion's TimelineEntry id is recorded in
    `created_entry_ids` as it happens.
  - In a `finally` block (runs whether the test run passed, failed, or
    raised), a temporary .ts file is written to the OS temp directory
    (never into the repo), which deletes EXACTLY those ids' rows —
    AuditEvent, then AiScribedNote, then Version (expected 0, cleaned
    defensively), then TimelineEntry — via Prisma `deleteMany({ where: { id:
    { in: exactIds } } })`. No fuzzy/content-based/patientId-wide deletes.
  - The temp file is removed immediately after running, regardless of
    outcome (via `tempfile.TemporaryDirectory()`).
  - The cleanup script prints only counts (metadata), never DATABASE_URL,
    secrets, or content.
  - If cleanup itself fails, the overall exit code is non-zero and the
    failure is reported explicitly — a passing test run never masks a
    failed cleanup.
  - A read-only baseline TimelineEntry count is taken before any ingestion
    and re-checked after cleanup, to confirm this run left no net change.

Known limitation of the black-box approach (documented honestly, not
silently skipped): there is no GET endpoint exposing AiScribedNote or
AuditEvent rows directly, so "AiScribedNote.redacted = true" and "AuditEvent
action = note_created" are not independently asserted here — they are
guaranteed by construction because they are written in the same
prisma.$transaction as the TimelineEntry this file does verify (see
src/app/api/patients/[id]/ai-scribe/route.ts). The cleanup script's own
deletedAiScribedNotes/deletedAuditEvents counts (checked against the number
of ids created) give indirect confirmation that a matching row existed in
each table for every created TimelineEntry.

PHI-safe stdout: no check() label or printed line ever contains a raw
fixture value (name/NRIC/phone) — only case indices and category
descriptions. This holds even though all fixture data here is synthetic.

Usage:
  python test_ai_scribe_ingestion.py

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

# ─── Synthetic fixture identifiers (must match prisma/seed.ts) ────────────
FIXTURE_EMAILS = {
    "patient_a": "patient.a@clinic-a.test",
    "staff_a": "staff.a@clinic-a.test",
    "clinician_a": "clinician.a@clinic-a.test",
    "admin_a": "admin.a@clinic-a.test",
    "clinician_b": "clinician.b@clinic-b.test",
}

PATIENT_A_ID = "synthetic-patient-a"

# Known names in Clinic A (must match prisma/seed.ts) — these are exactly the
# values the ai-scribe route feeds to redactPHI() as knownNames for a
# Patient A ingestion call: target Patient.displayName + every same-clinic
# User.name.
KNOWN_PATIENT_NAME = "Synthetic Patient A"
KNOWN_STAFF_NAME = "Synthetic Staff User A"

# Unknown-name fallback: fires ONLY on an explicit person-title prefix
# (Dr/Mr/Mrs/Ms), bounded to at most TWO name tokens after the title. Each
# (phrase, surname) pair is used to prove the WHOLE phrase collapses to one
# [NAME] — the surname must not survive as a residual fragment (the defect
# found in code review: "Dr Alice Lee" -> "[NAME] Lee").
TITLE_NAME_CASES = [
    ("Dr Alice Lee", "Lee"),
    ("Mr John Tan", "Tan"),
    ("Mrs Mary Wong", "Wong"),
    ("Ms Sarah Lim", "Lim"),
]

# Regression coverage for the over-redaction defect found in code review:
# an unbounded fallback would swallow Title-Case clinical text with no
# lowercase buffer word after the name (e.g. "Dr Alice Lee General
# Surgery" -> a single "[NAME]"). Bounding to 2 name tokens must preserve
# the clinical tail as plain text instead.
TITLE_NAME_CLINICAL_TAIL_CASES = [
    ("Dr Alice Lee General Surgery consult note.", "General Surgery"),
    ("Reviewed by Dr Alice Lee for Chest Pain.", "Chest Pain"),
]

# Documented, ACCEPTED prototype limitation (not a failure): an unknown
# three-token name is only partially redacted, because the fallback cannot
# distinguish a genuine third name token from the start of an unrelated
# capitalized phrase. System-known names of any token count remain fully
# covered by knownNames exact matching (items 1-2) — this only affects a
# third-party name that is both unknown to the system AND three tokens long.
THREE_TOKEN_UNKNOWN_NAME = "Dr Tan Wei Ming"
THREE_TOKEN_RESIDUAL = "Ming"

# Ordinary clinical phrases that must NOT be treated as names — none carry a
# Dr/Mr/Mrs/Ms prefix, so the narrowed fallback must leave them untouched.
CLINICAL_PHRASE_NEGATIVES = [
    "Chest Pain",
    "Blood Pressure",
    "General Surgery",
    "Singapore General Hospital",
    "Type Two Diabetes",
]

# NRIC/FIN: full required positive coverage (all 4 prefix letters + the
# lowercase fail-safe case) and negative coverage (wrong prefix, too short,
# too long).
NRIC_MUST_MATCH = [
    ("S1234567A", "S prefix"),
    ("T1234567B", "T prefix"),
    ("F1234567N", "F prefix"),
    ("G1234567X", "G prefix"),
    ("s1234567a", "lowercase, fail-safe"),
]
NRIC_MUST_NOT_MATCH = [
    ("M1234567X", "wrong prefix letter"),
    ("S123456A", "too short"),
    ("S12345678A", "too long"),
]
ID_EXAMPLE = "S1234567A"  # used by the primary fixture / persistence checks

# Singapore phone: optional +65 country code, 8-digit local number starting
# 6/8/9, optional space/hyphen separator.
SG_PHONE_MUST_MATCH = [
    "91234567",
    "9123 4567",
    "9123-4567",
    "+65 91234567",
    "+65 9123 4567",
    "+65 9123-4567",
    "+6591234567",
    "61234567",
    "6123 4567",
    "81234567",
]
PHONE_EXAMPLE = "+65 9123 4567"  # primary Singapore demo/test phone format

# Values that must NOT be redacted as phone numbers — ordinary clinical
# numerics, wrong-prefix/wrong-length digit runs, and digits embedded in a
# longer run (record numbers).
PHONE_MUST_NOT_MATCH = [
    "500",
    "2026",
    "120/80",
    "5 mg",
    "2 days",
    "650mg",
    "61234567890",
    "12345678",
    "51234567",
    "+65 1234 5678",
]

# Legacy compatibility ONLY — the non-Singapore example from
# requirements.md / execution-plan.md. Not the primary demo/test format.
LEGACY_PHONE_EXAMPLE = "0912-345-678"

# Near-miss formats that must NOT be swept up by the narrow legacy
# dash-4-3-3 fallback (regression coverage for over-redaction risk).
LEGACY_NEAR_MISS_NEGATIVES = [
    "2026-08-26",
    "120-80",
    "123-456-789",
    "500-250-125",
]

# Primary Singapore fixture. Uses a title-prefixed name ("Mr John Tan") so
# it exercises the unknown-name fallback specifically — NOT knownNames exact
# matching, which is covered separately by items 1-2. "John Tan" is not a
# seed.ts Patient.displayName or User.name.
PRIMARY_SG_INPUT = (
    "Patient: Mr John Tan, NRIC S1234567A, phone +65 9123 4567.\n"
    "Reports chest pain for two days."
)
PRIMARY_SG_EXPECTED = (
    "Patient: [NAME], NRIC [ID_NUMBER], phone [PHONE].\n"
    "Reports chest pain for two days."
)

_token_cache = {}
results = []
created_entry_ids = []


def _http_json(method, path, token=None, body=None):
    """Issue one HTTP request. Returns (status, parsed_json_or_None).
    Never logs the request or response body — only status/labels are
    printed by callers."""
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
    """Exchange a synthetic fixture email for a real JWT via the login API."""
    if email in _token_cache:
        return _token_cache[email]
    status, payload = _http_json(
        "POST", "/api/auth/login", body={"email": email}
    )
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


def content_of(body):
    """Defensive content extraction — never raises even if body is None or
    missing the field."""
    return body.get("content", "") if isinstance(body, dict) else ""


def ingest(actor_key, patient_id, session_type, session_id, raw_text):
    """POST to the AI Scribe endpoint. Tracks the created TimelineEntry id
    (if any) for cleanup, regardless of which caller invoked this."""
    token = login(FIXTURE_EMAILS[actor_key])
    status, body = _http_json(
        "POST",
        f"/api/patients/{patient_id}/ai-scribe",
        token=token,
        body={
            "sessionType": session_type,
            "sessionId": session_id,
            "rawText": raw_text,
        },
    )
    if status == 201 and isinstance(body, dict) and isinstance(body.get("id"), str):
        created_entry_ids.append(body["id"])
    return status, body


def get_entry(actor_key, entry_id):
    token = login(FIXTURE_EMAILS[actor_key])
    return _http_json("GET", f"/api/timeline/{entry_id}", token=token)


def get_versions(actor_key, entry_id):
    token = login(FIXTURE_EMAILS[actor_key])
    return _http_json("GET", f"/api/timeline/{entry_id}/versions", token=token)


def count_timeline_entries(actor_key, patient_id):
    token = login(FIXTURE_EMAILS[actor_key])
    status, payload = _http_json(
        "GET", f"/api/patients/{patient_id}/timeline", token=token
    )
    if status != 200 or not isinstance(payload, list):
        raise RuntimeError(f"Unexpected response listing timeline (status {status})")
    return len(payload)


# ─── Cleanup: throwaway Prisma script via the existing tsx toolchain ──────
# No DELETE endpoint exists anywhere in this API, so this is the only way to
# actually remove rows. Deletes ONLY the exact ids this run created (never a
# content/patientId-wide condition). Writes to the OS temp directory only,
# never into the repo, and removes the script immediately after running.
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
    rows) via a temp Prisma script. Returns (ok, counts_or_None, error_or_None).
    Never raises — any failure to even run the subprocess is reported as
    ok=False rather than propagated, so this is always safe to call from a
    `finally` block."""
    project_root = os.path.dirname(os.path.abspath(__file__))
    prisma_client_path = os.path.join(
        project_root, "src", "generated", "prisma", "client"
    )

    try:
        with tempfile.TemporaryDirectory(prefix="nightingale-ai-scribe-cleanup-") as tmpdir:
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


def run_tests():
    print(f"Target: {BASE_URL}\n")

    # ─── 1-2: knownNames exact redaction ─────────────────────────────────
    print("-- PHI redaction: knownNames exact match --")

    status, body = ingest(
        "staff_a", PATIENT_A_ID, "doctor_consult", "session-redact-patient-name",
        f"Consult note regarding {KNOWN_PATIENT_NAME}. No other identifiers here.",
    )
    content = content_of(body)
    check(
        "1. known Patient name redacted",
        status == 201 and KNOWN_PATIENT_NAME not in content and "[NAME]" in content,
    )

    status, body = ingest(
        "staff_a", PATIENT_A_ID, "doctor_consult", "session-redact-staff-name",
        f"Discussed case with {KNOWN_STAFF_NAME} present during consult.",
    )
    content = content_of(body)
    check(
        "2. same-clinic User name redacted",
        status == 201 and KNOWN_STAFF_NAME not in content and "[NAME]" in content,
    )

    # ─── 3a-3d / 3n1-3n5: unknown-name title-prefix fallback ─────────────
    print("\n-- PHI redaction: unknown-name title-prefix fallback --")

    for i, (phrase, surname) in enumerate(TITLE_NAME_CASES, start=1):
        status, body = ingest(
            "staff_a", PATIENT_A_ID, "doctor_consult", f"session-redact-title-{i}",
            f"Referred by {phrase} for follow-up.",
        )
        content = content_of(body)
        check(
            f"3{chr(96 + i)}. title-prefixed name fallback case {i} "
            "collapses to a single [NAME] (no residual surname)",
            status == 201
            and phrase not in content
            and surname not in content
            and "[NAME]" in content,
        )

    for i, phrase in enumerate(CLINICAL_PHRASE_NEGATIVES, start=1):
        status, body = ingest(
            "staff_a", PATIENT_A_ID, "doctor_consult", f"session-negative-clinicalphrase-{i}",
            f"Assessment: {phrase} noted during visit.",
        )
        content = content_of(body)
        check(
            f"3n{i}. clinical phrase negative case {i} not treated as a name",
            status == 201 and phrase in content and "[NAME]" not in content,
        )

    # Regression: bounding the fallback to 2 name tokens must preserve the
    # clinical tail as plain text, not swallow it into "[NAME]".
    for i, (raw_text, clinical_tail) in enumerate(TITLE_NAME_CLINICAL_TAIL_CASES, start=1):
        status, body = ingest(
            "staff_a", PATIENT_A_ID, "doctor_consult", f"session-redact-title-tail-{i}",
            raw_text,
        )
        content = content_of(body)
        check(
            f"3t{i}. title-prefixed fallback preserves clinical tail case {i}",
            status == 201 and "[NAME]" in content and clinical_tail in content,
        )

    # Documented, accepted limitation: an unknown three-token name is only
    # partially redacted (the fallback bound cannot distinguish a genuine
    # third name token from an unrelated capitalized phrase). This asserts
    # the KNOWN trade-off behavior, not a bug — see redact-phi.ts header.
    status, body = ingest(
        "staff_a", PATIENT_A_ID, "doctor_consult", "session-limitation-three-token-name",
        f"Consulted with {THREE_TOKEN_UNKNOWN_NAME} yesterday.",
    )
    content = content_of(body)
    check(
        "3-limitation. unknown three-token name only partially redacted "
        "(documented prototype trade-off)",
        status == 201 and "[NAME]" in content and THREE_TOKEN_RESIDUAL in content,
    )

    # ─── 4a-4e / 4n1-4n3: NRIC / FIN ──────────────────────────────────────
    print("\n-- PHI redaction: NRIC / FIN --")

    for i, (nric, _desc) in enumerate(NRIC_MUST_MATCH, start=1):
        status, body = ingest(
            "staff_a", PATIENT_A_ID, "doctor_consult", f"session-redact-nric-{i}",
            f"Patient NRIC on file: {nric}.",
        )
        content = content_of(body)
        check(
            f"4{chr(96 + i)}. NRIC case {i} redacted -> [ID_NUMBER]",
            status == 201 and nric not in content and "[ID_NUMBER]" in content,
        )

    for i, (value, _desc) in enumerate(NRIC_MUST_NOT_MATCH, start=1):
        status, body = ingest(
            "staff_a", PATIENT_A_ID, "doctor_consult", f"session-negative-nric-{i}",
            f"Reference code noted: {value}.",
        )
        content = content_of(body)
        check(
            f"4n{i}. NRIC negative case {i} preserved",
            status == 201 and value in content and "[ID_NUMBER]" not in content,
        )

    # ─── 5a-5j / 5n1-5n10 / 5-legacy(-n): Singapore + legacy phone ───────
    print("\n-- PHI redaction: Singapore phone --")

    for i, phone in enumerate(SG_PHONE_MUST_MATCH, start=1):
        status, body = ingest(
            "staff_a", PATIENT_A_ID, "doctor_consult", f"session-redact-sgphone-{i}",
            f"Callback number provided: {phone}.",
        )
        content = content_of(body)
        check(
            f"5{chr(96 + i)}. Singapore phone case {i} redacted -> [PHONE]",
            status == 201 and phone not in content and "[PHONE]" in content,
        )

    for i, value in enumerate(PHONE_MUST_NOT_MATCH, start=1):
        status, body = ingest(
            "staff_a", PATIENT_A_ID, "doctor_consult", f"session-negative-sgphone-{i}",
            f"Clinical note value: {value} recorded during visit.",
        )
        content = content_of(body)
        check(
            f"5n{i}. Singapore phone negative case {i} not over-redacted",
            status == 201 and value in content and "[PHONE]" not in content,
        )

    status, body = ingest(
        "staff_a", PATIENT_A_ID, "doctor_consult", "session-redact-legacy-phone",
        f"Callback number provided: {LEGACY_PHONE_EXAMPLE}.",
    )
    content = content_of(body)
    check(
        "5-legacy. legacy dash-4-3-3 format still redacted via fallback (not primary)",
        status == 201 and LEGACY_PHONE_EXAMPLE not in content and "[PHONE]" in content,
    )

    for i, value in enumerate(LEGACY_NEAR_MISS_NEGATIVES, start=1):
        status, body = ingest(
            "staff_a", PATIENT_A_ID, "doctor_consult", f"session-negative-legacy-{i}",
            f"Reference value noted: {value} during review.",
        )
        content = content_of(body)
        check(
            f"5-legacy-n{i}. legacy near-miss case {i} not over-redacted",
            status == 201 and value in content and "[PHONE]" not in content,
        )

    # ─── 6: primary Singapore fixture (exact expected output) ───────────
    print("\n-- Primary Singapore fixture --")

    status, combined_body = ingest(
        "staff_a", PATIENT_A_ID, "doctor_consult", "session-redact-combined",
        PRIMARY_SG_INPUT,
    )
    combined_id = combined_body.get("id") if isinstance(combined_body, dict) else None
    combined_content = content_of(combined_body)
    check(
        "6. primary Singapore fixture (title-prefixed name) redacts to the "
        "exact expected output",
        status == 201 and combined_id is not None and PRIMARY_SG_EXPECTED in combined_content,
    )

    # ─── 7-9: session-type mapping ──────────────────────────────────────
    print("\n-- Session-type mapping --")

    status, doctor_body = ingest(
        "clinician_a", PATIENT_A_ID, "doctor_consult", "session-map-doctor-001",
        "Doctor consult: patient reports improved symptoms.",
    )
    doctor_id = doctor_body.get("id") if isinstance(doctor_body, dict) else None
    check(
        "7. doctor_consult -> ai_doctor_consult_summary / doctor_consult",
        status == 201 and isinstance(doctor_body, dict)
        and doctor_body.get("type") == "ai_doctor_consult_summary"
        and doctor_body.get("provenanceType") == "doctor_consult"
        and doctor_body.get("provenanceId") == "session-map-doctor-001",
    )

    status, nurse_body = ingest(
        "staff_a", PATIENT_A_ID, "nurse_consult", "session-map-nurse-001",
        "Nurse consult: vitals stable, no new complaints.",
    )
    check(
        "8. nurse_consult -> ai_nurse_consult_summary / nurse_consult",
        status == 201 and isinstance(nurse_body, dict)
        and nurse_body.get("type") == "ai_nurse_consult_summary"
        and nurse_body.get("provenanceType") == "nurse_consult"
        and nurse_body.get("provenanceId") == "session-map-nurse-001",
    )

    status, patient_session_body = ingest(
        "staff_a", PATIENT_A_ID, "patient_session", "session-map-patient-001",
        "AI-patient session: patient asked about medication timing.",
    )
    check(
        "9. patient_session -> ai_patient_session_summary / patient_session",
        status == 201 and isinstance(patient_session_body, dict)
        and patient_session_body.get("type") == "ai_patient_session_summary"
        and patient_session_body.get("provenanceType") == "patient_session"
        and patient_session_body.get("provenanceId") == "session-map-patient-001",
    )

    # ─── 10-14: RBAC on the ingestion endpoint ──────────────────────────
    print("\n-- RBAC --")

    status, _ = ingest(
        "staff_a", PATIENT_A_ID, "doctor_consult", "session-rbac-staff",
        "Routine consult note.",
    )
    check("10. Staff (same clinic) allowed -> 201", status == 201)

    status, _ = ingest(
        "clinician_a", PATIENT_A_ID, "doctor_consult", "session-rbac-clinician",
        "Routine consult note.",
    )
    check("11. Clinician (same clinic) allowed -> 201", status == 201)

    status, _ = ingest(
        "patient_a", PATIENT_A_ID, "patient_session", "session-rbac-patient",
        "Routine consult note.",
    )
    check("12. Patient denied -> 403", status == 403)

    status, _ = ingest(
        "admin_a", PATIENT_A_ID, "doctor_consult", "session-rbac-admin",
        "Routine consult note.",
    )
    check("13. Admin denied -> 403", status == 403)

    status, _ = ingest(
        "clinician_b", PATIENT_A_ID, "doctor_consult", "session-rbac-cross-clinic",
        "Routine consult note.",
    )
    check("14. Cross-clinic caller denied -> 403", status == 403)

    # ─── 15-16, 18, 20: persistence correctness ─────────────────────────
    print("\n-- Persistence --")

    if combined_id is not None:
        # Re-fetch via a SEPARATE request to prove the redaction survived to
        # storage, not just the create response.
        persisted_status, persisted = get_entry("clinician_a", combined_id)
        persisted_content = content_of(persisted)
        check(
            "15. persisted content contains no raw PHI",
            persisted_status == 200
            and "John Tan" not in persisted_content
            and ID_EXAMPLE not in persisted_content
            and PHONE_EXAMPLE not in persisted_content,
        )
        check(
            "16. persisted content contains expected redaction tokens",
            persisted_status == 200
            and "[NAME]" in persisted_content
            and "[ID_NUMBER]" in persisted_content
            and "[PHONE]" in persisted_content,
        )
        check(
            "18. persisted provenanceType/provenanceId correct",
            persisted_status == 200
            and isinstance(persisted, dict)
            and persisted.get("provenanceType") == "doctor_consult"
            and persisted.get("provenanceId") == "session-redact-combined",
        )
    else:
        check("15. persisted content contains no raw PHI", False)
        check("16. persisted content contains expected redaction tokens", False)
        check("18. persisted provenanceType/provenanceId correct", False)

    if doctor_id is not None:
        versions_status, versions_body = get_versions("clinician_a", doctor_id)
        vb = versions_body if isinstance(versions_body, dict) else {}
        check(
            "20. no initial Version row on create (versionNumber=1, versions=[])",
            versions_status == 200
            and vb.get("currentVersionNumber") == 1
            and vb.get("versions") == [],
        )
    else:
        check("20. no initial Version row on create (versionNumber=1, versions=[])", False)

    # ─── 21: failure leaves no partial writes ───────────────────────────
    print("\n-- Failure semantics --")

    before_count = count_timeline_entries("staff_a", PATIENT_A_ID)
    token = login(FIXTURE_EMAILS["staff_a"])
    # Missing rawText -> validation must fail before the patient is even
    # looked up, so nothing should be written.
    invalid_status, _ = _http_json(
        "POST",
        f"/api/patients/{PATIENT_A_ID}/ai-scribe",
        token=token,
        body={"sessionType": "doctor_consult", "sessionId": "session-invalid"},
    )
    after_count = count_timeline_entries("staff_a", PATIENT_A_ID)
    check(
        "21. validation failure leaves zero new TimelineEntry rows",
        invalid_status == 400 and after_count == before_count,
    )


if __name__ == "__main__":
    baseline_count = None
    try:
        baseline_count = count_timeline_entries("staff_a", PATIENT_A_ID)
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
        expected = len(created_entry_ids)
        counts_match = (
            isinstance(cleanup_counts, dict)
            and cleanup_counts.get("deletedTimelineEntries") == expected
            and cleanup_counts.get("deletedAiScribedNotes") == expected
            and cleanup_counts.get("deletedAuditEvents") == expected
        )
        check("cleanup. temp Prisma cleanup script succeeded", True)
        check("cleanup. deleted counts match created count", counts_match)
    else:
        check("cleanup. temp Prisma cleanup script succeeded", False)
        print(f"CLEANUP FAILURE: {cleanup_error}")

    if baseline_count is not None:
        try:
            final_count = count_timeline_entries("staff_a", PATIENT_A_ID)
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
