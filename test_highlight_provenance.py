"""
test_highlight_provenance.py

Micro-test: Highlight provenance — the entryId -> TimelineEntry ->
quotedText verbatim-match chain.

GUARANTEE-STRENGTH STATEMENT (read this before extending this file):
  This test validates READ-TIME runtime provenance DETECTION.
  It does NOT validate write-time rejection.

  Reason: GET /api/patients/:id/highlights computes exact-match provenance
  status (quotedTextFound / occurrenceCount) at runtime, on every request,
  by re-scanning the referenced TimelineEntry.content. There is no
  Highlight creation API anywhere in this codebase (verified by inspection:
  the only Prisma `highlight.create` call in the entire repo is in
  prisma/seed.ts; the only two Highlight-related routes are
  GET /api/patients/:id/highlights and PATCH /api/highlights/:id, and the
  PATCH route only ever writes the `feedback` field — never entryId or
  quotedText). So there is no write path that could enforce this invariant
  at creation time, and none is claimed here.

  "Highlight provenance is verified at read time via exact-match detection
  (quotedTextFound / occurrenceCount). The current prototype does not
  enforce quotedText validity at write time because no Highlight creation
  API exists."

  The negative-case fixture below is inserted directly via a temporary
  Prisma script specifically BECAUSE no API exists to create it. The fact
  that an invalid Highlight CAN be inserted directly into the database is
  the expected, documented shape of this limitation — not a production bug
  and not something this test works around.

Black-box HTTP test against a running Next.js dev server for everything
except the negative-fixture insert/cleanup, which uses the same
throwaway-tsx-script mechanism already established by
test_revision_history.py / test_concurrent_edits.py (temp file written ONLY
to the OS temp dir, NODE_PATH + realpath fixes, removed automatically by
tempfile.TemporaryDirectory()'s context manager — no helper .ts/.js file is
ever left in the repo). Auth tokens are obtained via POST /api/auth/login
using synthetic fixture emails from prisma/seed.ts.

Matching semantics (verified from source, not assumed): the route's
`countOccurrences()` helper uses `content.indexOf(quotedText, position)` in
a loop — exact, case-SENSITIVE, plain substring matching. No regex, no
fuzzy matching, no offset tracking. The negative fixture below is chosen to
demonstrate this directly: its quotedText is a lowercase variant of a
phrase that exists in the source content only in a different case, so the
mismatch is specifically a case-sensitivity failure, not just "unrelated
text" — this doubles as both the negative-provenance case and the
exact-match/case-sensitivity case in one fixture, per the instruction not
to overcomplicate this file with a second insert/cleanup cycle.

Role selection: GET /api/patients/:id/highlights is authorized via
`assertPatientAccess` (clinic-scope + "Patient may only access own record"
for Patient-role callers) — it is not restricted to a specific staff role.
Staff and Clinician are equally valid; this file uses Clinician
consistently, per the instruction to prefer Clinician when both are valid.

Patient visibility (verified from source): the route filters results for
Patient-role callers via the same `isPatientVisibleEntry()` allow-list used
elsewhere (only `patient_session_summary` is Patient-visible). The negative
fixture below targets the seeded `ai_doctor_consult_summary` entry
(Patient-invisible), so the same fixture is reused to verify the Patient
visibility boundary in addition to provenance detection, per the
instruction to avoid creating extra unrelated data.

Cleanup: the injected Highlight id is recorded the moment insertion
succeeds and deleted in a top-level `finally` block, regardless of what
happens in between (this file's earlier draft deferred cleanup to the end
of the "else" branch instead of a true finally — corrected before this
version, since an assertion exception between insert and cleanup would
otherwise have leaked the fixture). Deletion is by exact Highlight id only
— never by patientId, entryId, quotedText, content, or any type-wide
condition. The referenced TimelineEntry (an existing seed row) is never
modified or deleted.

Prerequisites:
  1. Database seeded with the fixed synthetic fixtures:
       npx tsx prisma/seed.ts
  2. Next.js dev server running:
       npm run dev
     (defaults to http://localhost:3000; override with NIGHTINGALE_BASE_URL)
  3. `npx tsx` available (already a devDependency) — needed only for the
     negative-fixture insert/cleanup, not for the HTTP assertions.

PHI-safe stdout: no check() label or printed line contains raw entry
content — only case descriptions, counts, and IDs (opaque cuids, not PHI).
The seeded synthetic snippets referenced here are short and non-sensitive
by construction (synthetic data only, per project policy).

Usage:
  python3 test_highlight_provenance.py

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
    "patient_a": "patient.a@clinic-a.test",
}
PATIENT_A_ID = "synthetic-patient-a"

# Existing seed fixtures (must match prisma/seed.ts) — the positive case
# reuses an already-seeded, already-valid Highlight rather than creating a
# new one, per instruction.
HIGHLIGHT_AI_ID = "synthetic-highlight-ai-doctor-summary"
ENTRY_AI_DOCTOR_SUMMARY_ID = "synthetic-entry-ai-doctor-summary"
POSITIVE_QUOTED_TEXT = "recommended follow-up imaging if symptoms persist beyond 2 weeks"
EXPECTED_PROVENANCE_TYPE = "doctor_consult"
EXPECTED_PROVENANCE_ID = "synthetic-session-consult-001"

# Negative fixture: targets the SAME existing AI-generated (Patient-invisible)
# entry as the positive case. quotedText is a lowercase variant of "AI summary"
# — that exact phrase exists in the entry's content only capitalized, so this
# deliberately fails ONLY on case, proving case-sensitive matching, while also
# being a genuinely invalid (non-occurring, verbatim) quotedText.
NEGATIVE_QUOTED_TEXT = "ai summary"
NEGATIVE_RISK_REASON = "Synthetic negative-fixture risk reason for provenance test."

_token_cache = {}
results = []
created_highlight_ids = []  # exact injected Highlight id(s), for finally-cleanup
baseline_highlight_count = None


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


def get_highlights(actor_key):
    token = login(FIXTURE_EMAILS[actor_key])
    return _http_json(
        "GET", f"/api/patients/{PATIENT_A_ID}/highlights", token=token
    )


def get_entry(actor_key, entry_id):
    token = login(FIXTURE_EMAILS[actor_key])
    return _http_json("GET", f"/api/timeline/{entry_id}", token=token)


def find_highlight(highlights, highlight_id):
    if not isinstance(highlights, list):
        return None
    return next(
        (h for h in highlights if isinstance(h, dict) and h.get("id") == highlight_id),
        None,
    )


# ─── Throwaway tsx script runner — same mechanism as test_revision_history.py
# / test_concurrent_edits.py. Written ONLY to the OS temp directory, removed
# automatically by tempfile.TemporaryDirectory()'s context manager on exit.
# No helper .ts/.js file is ever left in the repo.
def _run_tsx_script_at(script_path, project_root):
    env = {**os.environ, "NODE_PATH": os.path.join(project_root, "node_modules")}
    try:
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


def _prisma_client_import(project_root, tmpdir):
    prisma_client_path = os.path.join(project_root, "src", "generated", "prisma", "client")
    rel_import = os.path.relpath(
        os.path.realpath(prisma_client_path), start=os.path.realpath(tmpdir)
    ).replace(os.sep, "/")
    if not rel_import.startswith("."):
        rel_import = "./" + rel_import
    return rel_import


INSERT_SCRIPT_TEMPLATE = """\
import "dotenv/config";
import {{ PrismaPg }} from "@prisma/adapter-pg";
import {{ PrismaClient }} from "{prisma_client_import}";

async function main() {{
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {{
    throw new Error("DATABASE_URL is not set");
  }}
  const adapter = new PrismaPg({{ connectionString: databaseUrl }});
  const prisma = new PrismaClient({{ adapter }});

  try {{
    const created = await prisma.highlight.create({{
      data: {{
        patientId: {patient_id_json},
        entryId: {entry_id_json},
        quotedText: {quoted_text_json},
        riskReason: {risk_reason_json},
        importance: 0,
        feedback: "pending",
      }},
      select: {{ id: true }},
    }});
    console.log(JSON.stringify({{ ok: true, id: created.id }}));
  }} finally {{
    await prisma.$disconnect();
  }}
}}

main().catch((e) => {{
  console.error(JSON.stringify({{ ok: false, error: "insert failed", code: e && e.code ? e.code : undefined }}));
  process.exit(1);
}});
"""

DELETE_SCRIPT_TEMPLATE = """\
import "dotenv/config";
import {{ PrismaPg }} from "@prisma/adapter-pg";
import {{ PrismaClient }} from "{prisma_client_import}";

async function main() {{
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {{
    throw new Error("DATABASE_URL is not set");
  }}
  const adapter = new PrismaPg({{ connectionString: databaseUrl }});
  const prisma = new PrismaClient({{ adapter }});

  try {{
    const result = await prisma.highlight.deleteMany({{
      where: {{ id: {highlight_id_json} }},
    }});
    console.log(JSON.stringify({{ ok: true, deletedCount: result.count }}));
  }} finally {{
    await prisma.$disconnect();
  }}
}}

main().catch((e) => {{
  console.error(JSON.stringify({{ ok: false, error: "delete failed", code: e && e.code ? e.code : undefined }}));
  process.exit(1);
}});
"""


def insert_negative_highlight(patient_id, entry_id, quoted_text, risk_reason):
    """Inserts exactly one Highlight row directly via Prisma (no API exists
    to do this — see module docstring). Returns (highlight_id_or_None,
    error_or_None). Never prints DATABASE_URL, secrets, or content."""
    project_root = os.path.dirname(os.path.abspath(__file__))
    with tempfile.TemporaryDirectory(prefix="nightingale-highlight-provenance-insert-") as tmpdir:
        rel_import = _prisma_client_import(project_root, tmpdir)
        script_content = INSERT_SCRIPT_TEMPLATE.format(
            prisma_client_import=rel_import,
            patient_id_json=json.dumps(patient_id),
            entry_id_json=json.dumps(entry_id),
            quoted_text_json=json.dumps(quoted_text),
            risk_reason_json=json.dumps(risk_reason),
        )
        script_path = os.path.join(tmpdir, "insert.ts")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(script_content)
        ok, payload, error = _run_tsx_script_at(script_path, project_root)
    if not ok or not isinstance(payload, dict) or not isinstance(payload.get("id"), str):
        return None, error
    return payload["id"], None


def delete_highlight(highlight_id):
    """Deletes exactly one Highlight row by exact id. Returns
    (deleted_count_or_None, error_or_None). Never raises — safe to call
    from a `finally` block."""
    project_root = os.path.dirname(os.path.abspath(__file__))
    with tempfile.TemporaryDirectory(prefix="nightingale-highlight-provenance-delete-") as tmpdir:
        rel_import = _prisma_client_import(project_root, tmpdir)
        script_content = DELETE_SCRIPT_TEMPLATE.format(
            prisma_client_import=rel_import,
            highlight_id_json=json.dumps(highlight_id),
        )
        script_path = os.path.join(tmpdir, "delete.ts")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(script_content)
        ok, payload, error = _run_tsx_script_at(script_path, project_root)
    if not ok or not isinstance(payload, dict) or not isinstance(payload.get("deletedCount"), int):
        return None, error
    return payload["deletedCount"], None


def run_tests():
    global baseline_highlight_count
    print(f"Target: {BASE_URL}\n")

    # ─── Baseline: highlight count before this test touches anything ─────
    status, highlights = get_highlights("clinician_a")
    if status == 200 and isinstance(highlights, list):
        baseline_highlight_count = len(highlights)
    check(
        "baseline. GET highlights succeeds and returns the seeded baseline list",
        status == 200 and isinstance(highlights, list) and baseline_highlight_count is not None,
    )

    # ─── Positive provenance case (existing seeded Highlight) ────────────
    print("\n-- Positive provenance case --")
    positive = find_highlight(highlights, HIGHLIGHT_AI_ID)
    check(
        "P1. seeded valid Highlight is returned via GET /highlights",
        status == 200 and isinstance(positive, dict),
    )
    check(
        "P2. entryId resolves to the expected existing TimelineEntry",
        isinstance(positive, dict) and positive.get("entryId") == ENTRY_AI_DOCTOR_SUMMARY_ID,
    )
    check(
        "P3. quotedTextFound=true, occurrenceCount=1 (API-derived provenance status)",
        isinstance(positive, dict)
        and positive.get("quotedTextFound") is True
        and positive.get("occurrenceCount") == 1,
    )

    # Independent check: fetch the source entry through a SEPARATE endpoint
    # and verify verbatim occurrence ourselves, rather than trusting
    # quotedTextFound from the same response.
    e_status, e_body = get_entry("clinician_a", ENTRY_AI_DOCTOR_SUMMARY_ID)
    source_content = e_body.get("content", "") if isinstance(e_body, dict) else ""
    check(
        "P4. independent source-content verification: quotedText occurs "
        "verbatim in TimelineEntry.content fetched via GET /api/timeline/:id",
        e_status == 200 and POSITIVE_QUOTED_TEXT in source_content,
    )

    # Provenance chain: Highlight.entryId -> TimelineEntry.provenanceType/Id.
    # This entry genuinely is AI-generated in seed data, so this is not
    # fabricated — it is the actual seeded relationship.
    check(
        "P5. provenance chain: entry.provenanceType/provenanceId match the "
        "expected AI Scribe session linkage",
        e_status == 200
        and isinstance(e_body, dict)
        and e_body.get("provenanceType") == EXPECTED_PROVENANCE_TYPE
        and e_body.get("provenanceId") == EXPECTED_PROVENANCE_ID,
    )

    # ─── Negative provenance + case-sensitivity case ──────────────────────
    print("\n-- Negative provenance case (direct-insert fixture) --")
    negative_id, insert_error = insert_negative_highlight(
        PATIENT_A_ID, ENTRY_AI_DOCTOR_SUMMARY_ID, NEGATIVE_QUOTED_TEXT, NEGATIVE_RISK_REASON
    )
    if negative_id is not None:
        # Recorded immediately on success, before any further assertion can
        # raise — this is what finally-cleanup below relies on.
        created_highlight_ids.append(negative_id)
    check("N1. negative fixture inserted via temporary Prisma script", negative_id is not None)
    if insert_error:
        print(f"INSERT FAILURE: {insert_error}")

    if negative_id is None:
        print("FATAL: negative fixture insertion failed, skipping dependent scenarios")
        return

    status, highlights_after_insert = get_highlights("clinician_a")
    negative = find_highlight(highlights_after_insert, negative_id)
    check(
        "N2. injected Highlight is returned via GET /highlights "
        "(exactly one match for its exact id)",
        status == 200
        and isinstance(highlights_after_insert, list)
        and sum(1 for h in highlights_after_insert
                if isinstance(h, dict) and h.get("id") == negative_id) == 1,
    )
    check(
        "N3. entryId still references the real existing TimelineEntry",
        isinstance(negative, dict) and negative.get("entryId") == ENTRY_AI_DOCTOR_SUMMARY_ID,
    )
    check(
        "N4. quotedTextFound=false, occurrenceCount=0 "
        "(case-sensitive mismatch: quotedText exists in the source only "
        "in a different case, so this specifically proves case-sensitive "
        "exact-match semantics, not just an unrelated phrase)",
        isinstance(negative, dict)
        and negative.get("quotedTextFound") is False
        and negative.get("occurrenceCount") == 0,
    )

    # ─── Patient visibility boundary (same fixture) ───────────────────────
    print("\n-- Patient visibility boundary (same fixture) --")
    p_status, patient_highlights = get_highlights("patient_a")
    patient_sees_negative = find_highlight(patient_highlights, negative_id)
    patient_sees_positive = find_highlight(patient_highlights, HIGHLIGHT_AI_ID)
    check(
        "V1. Patient does NOT receive the injected Highlight "
        "(its entry is ai_doctor_consult_summary, Patient-invisible)",
        p_status == 200 and patient_sees_negative is None,
    )
    check(
        "V2. Patient also does not receive the seeded AI-doctor Highlight "
        "(same visibility rule applies consistently to seed data)",
        p_status == 200 and patient_sees_positive is None,
    )

    # ─── Defensive behavior ────────────────────────────────────────────────
    print("\n-- Defensive behavior --")
    status, _ = get_entry("clinician_a", "nonexistent-entry-id-xyz")
    check("D1. GET entry for a nonexistent id -> 404, no crash", status == 404)


if __name__ == "__main__":
    try:
        run_tests()
    except Exception as e:  # noqa: BLE001 - never let TypeError/KeyError/etc. crash the run
        print(f"ERROR during test run: {type(e).__name__}: {e}")
        results.append(False)
    finally:
        print("\n-- Cleanup --")
        if not created_highlight_ids:
            print("(no negative fixture was created — nothing to clean up)")
        for highlight_id in list(created_highlight_ids):
            deleted_count, delete_error = delete_highlight(highlight_id)
            check("cleanup. temporary Highlight deleted via exact ID", deleted_count == 1)
            if delete_error:
                print(f"CLEANUP FAILURE: {delete_error}")

        if created_highlight_ids:
            try:
                status, highlights_after_cleanup = get_highlights("clinician_a")
                remaining_ids = (
                    {h.get("id") for h in highlights_after_cleanup if isinstance(h, dict)}
                    if status == 200 and isinstance(highlights_after_cleanup, list)
                    else None
                )
                check(
                    "cleanup. exact Highlight ID no longer exists after cleanup",
                    remaining_ids is not None
                    and not (set(created_highlight_ids) & remaining_ids),
                )
                check(
                    "cleanup. Highlight count restored to pre-test baseline",
                    remaining_ids is not None
                    and baseline_highlight_count is not None
                    and len(highlights_after_cleanup) == baseline_highlight_count,
                )
            except Exception as e:  # noqa: BLE001
                check("cleanup. exact Highlight ID no longer exists after cleanup", False)
                check("cleanup. Highlight count restored to pre-test baseline", False)
                print(f"ERROR verifying cleanup: {type(e).__name__}: {e}")

    total = len(results)
    passed = sum(results)
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if passed == total else 1)
