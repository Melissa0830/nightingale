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

Prerequisites:
  1. Database seeded with the fixed synthetic fixtures:
       npx tsx prisma/seed.ts
  2. Next.js dev server running:
       npm run dev
     (defaults to http://localhost:3000; override with NIGHTINGALE_BASE_URL)

WARNING: the last test case in this file performs a real, legitimate write
(Clinician A editing the "plan" section it owns). Running this script
mutates the synthetic baseline (see comment above that case for exactly
what changes). This script does NOT reset the baseline itself — re-run
`npx tsx prisma/seed.ts` after this script finishes to restore it.

Usage:
  python test_rbac_scope.py

Exit code: 0 if all cases pass, 1 if any case fails.
"""

import json
import os
import sys
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

    # ─── Summary ────────────────────────────────────────────────────────
    total = len(results)
    passed = sum(results)
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        print(f"[ERROR] {exc}")
        sys.exit(1)
