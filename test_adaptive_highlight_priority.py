"""
test_adaptive_highlight_priority.py

Micro-test: Feedback-Informed Adaptive Highlight Prioritization (Bonus).

Read-only integration check against the seeded, isolated learning fixture
(synthetic-patient-learning in Clinic A, synthetic-patient-learning-b in
Clinic B). It exercises the read-time derivation exposed by
GET /api/patients/:id/highlights:

  - same-clinic + same-normalized-riskReason accept/reject aggregation
  - `pending` feedback excluded from the threshold
  - deterministic threshold (>= 3 non-pending) and clamp (+/- 2)
  - normalization folds case / trailing period / whitespace into one bucket
  - Clinic A feedback never influences Clinic B and vice versa
  - Patient A seeded Highlights stay neutral (no cross-bucket leakage)

This test performs NO writes: the seeded feedback states already contain
3 accepted (Clinic A bucket X), 2 accepted (Clinic A bucket Y, below
threshold) and 3 rejected (Clinic B bucket X). No fixture creation, no
cleanup. The recompute-on-feedback-change loop is covered separately by
the block's runtime verification via PATCH /api/highlights/:id.

Setup:
  1. Database seeded: npx tsx prisma/seed.ts
  2. Dev server running (defaults to http://localhost:3000; override with
     NIGHTINGALE_BASE_URL).

Run:
  NIGHTINGALE_BASE_URL=http://localhost:3100 python3 test_adaptive_highlight_priority.py

Exit code: 0 if all cases pass, 1 otherwise.
"""

import json
import os
import sys
import urllib.error
import urllib.request

BASE_URL = os.environ.get("NIGHTINGALE_BASE_URL", "http://localhost:3000").rstrip("/")

FIXTURE_EMAILS = {
    "clinician_a": "clinician.a@clinic-a.test",
    "staff_a": "staff.a@clinic-a.test",
    "clinician_b": "clinician.b@clinic-b.test",
    "patient_a": "patient.a@clinic-a.test",
}

PATIENT_LEARNING = "synthetic-patient-learning"
PATIENT_LEARNING_B = "synthetic-patient-learning-b"
PATIENT_A = "synthetic-patient-a"

HL_X_A = "synthetic-highlight-learning-x-a"
HL_X_D = "synthetic-highlight-learning-x-d"
HL_Y_G = "synthetic-highlight-learning-y-g"
HL_XB_D = "synthetic-highlight-learning-xb-d"
HL_A_AI = "synthetic-highlight-ai-doctor-summary"

_token_cache = {}
results = []


def _http_json(method, path, token=None, body=None):
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw.decode("utf-8")) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, (json.loads(raw.decode("utf-8")) if raw else None)
        except json.JSONDecodeError:
            return e.code, None
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Cannot reach {BASE_URL} — is the Next.js dev server running? ({e.reason})"
        ) from e


def login(actor_key):
    if actor_key in _token_cache:
        return _token_cache[actor_key]
    status, payload = _http_json(
        "POST", "/api/auth/login", body={"email": FIXTURE_EMAILS[actor_key]}
    )
    if status != 200 or not isinstance(payload, dict) or not payload.get("token"):
        raise RuntimeError(
            f"Login failed for {actor_key} (status {status}); check that the database has been seeded"
        )
    token = payload["token"]
    _token_cache[actor_key] = token
    return token


def get_highlights(actor_key, patient_id):
    token = login(actor_key)
    return _http_json("GET", f"/api/patients/{patient_id}/highlights", token=token)


def check(name, condition):
    results.append(bool(condition))
    print(f"[{'PASS' if condition else 'FAIL'}] {name}")


def find(rows, hid):
    return next((h for h in rows if isinstance(h, dict) and h.get("id") == hid), None)


def run_tests():
    print(f"Target: {BASE_URL}\n")

    # ─── Clinic A learning patient ───────────────────────────────────────
    status, rows_a = get_highlights("clinician_a", PATIENT_LEARNING)
    check("A0. Clinician A can read learning-patient highlights -> 200", status == 200 and isinstance(rows_a, list))
    if not isinstance(rows_a, list):
        print("FATAL: cannot continue without the Clinic A highlight list")
        return

    x_d = find(rows_a, HL_X_D)
    check(
        "A1. bucket X target (pending) aggregates 3 prior accepts: "
        "acceptedCount=3, rejectedCount=0",
        x_d is not None and x_d.get("acceptedCount") == 3 and x_d.get("rejectedCount") == 0,
    )
    check(
        "A2. pending is excluded from the threshold: feedbackCount=3 "
        "(4 highlights in the bucket, 1 pending)",
        x_d is not None and x_d.get("feedbackCount") == 3,
    )
    check(
        "A3. threshold met -> learnedAdjustment = clamp(3-0) = +2",
        x_d is not None and x_d.get("learnedAdjustment") == 2,
    )
    check(
        "A4. effectiveImportance = baseImportance(0) + adjustment(+2) = 2; "
        "importance (base) still 0",
        x_d is not None and x_d.get("effectiveImportance") == 2 and x_d.get("importance") == 0,
    )

    x_a = find(rows_a, HL_X_A)
    check(
        "A5. an accepted member of the same bucket participates in its own "
        "aggregate: acceptedCount=3, adjustment=+2",
        x_a is not None and x_a.get("acceptedCount") == 3 and x_a.get("learnedAdjustment") == 2,
    )

    y_g = find(rows_a, HL_Y_G)
    check(
        "A6. below-threshold bucket Y (2 non-pending) -> learnedAdjustment=0",
        y_g is not None and y_g.get("feedbackCount") == 2 and y_g.get("learnedAdjustment") == 0,
    )
    check(
        "A7. below threshold -> effectiveImportance == baseImportance (0)",
        y_g is not None and y_g.get("effectiveImportance") == y_g.get("importance") == 0,
    )

    # ─── Clinic B learning patient ──────────────────────────────────────
    status, rows_b = get_highlights("clinician_b", PATIENT_LEARNING_B)
    check("B0. Clinician B can read Clinic B learning-patient highlights -> 200", status == 200 and isinstance(rows_b, list))
    xb_d = find(rows_b, HL_XB_D) if isinstance(rows_b, list) else None
    check(
        "B1. Clinic B bucket X target: acceptedCount=0, rejectedCount=3, "
        "learnedAdjustment = clamp(0-3) = -2",
        xb_d is not None
        and xb_d.get("acceptedCount") == 0
        and xb_d.get("rejectedCount") == 3
        and xb_d.get("learnedAdjustment") == -2
        and xb_d.get("effectiveImportance") == -2,
    )

    # ─── Cross-clinic isolation (hard requirement) ──────────────────────
    check(
        "C1. Clinic A bucket X target is unaffected by Clinic B's 3 rejects "
        "in the SAME normalized riskReason (still 3/0/+2)",
        x_d is not None
        and x_d.get("acceptedCount") == 3
        and x_d.get("rejectedCount") == 0
        and x_d.get("learnedAdjustment") == 2,
    )
    check(
        "C2. Clinic B bucket X target is unaffected by Clinic A's 3 accepts "
        "(still 0/3/-2)",
        xb_d is not None and xb_d.get("rejectedCount") == 3 and xb_d.get("acceptedCount") == 0,
    )
    check(
        "C3. cross-clinic read denied: Clinician B cannot read Clinic A "
        "learning-patient highlights -> 403",
        get_highlights("clinician_b", PATIENT_LEARNING)[0] == 403,
    )

    # ─── Normalization folds surface forms into one bucket ──────────────
    # X_A/X_B/X_C use "Persistent symptoms may require follow-up.",
    # "persistent symptoms may require follow-up" and
    # "Persistent  symptoms may  require follow-up." respectively. If
    # normalization were exact-match, the bucket would never reach 3.
    check(
        "D1. case / trailing-period / double-space surface forms all fold "
        "into one bucket (feedbackCount reached 3)",
        x_d is not None and x_d.get("feedbackCount") == 3,
    )

    # ─── Staff read-only sees derived fields; Patient A stays neutral ───
    status, rows_staff = get_highlights("staff_a", PATIENT_LEARNING)
    staff_x_d = find(rows_staff, HL_X_D) if isinstance(rows_staff, list) else None
    check(
        "E1. Staff (read-only) also receives derived adaptive fields "
        "(effectiveImportance=2)",
        status == 200 and staff_x_d is not None and staff_x_d.get("effectiveImportance") == 2,
    )

    status, rows_pa = get_highlights("clinician_a", PATIENT_A)
    pa_ai = find(rows_pa, HL_A_AI) if isinstance(rows_pa, list) else None
    check(
        "E2. Patient A seeded Highlight is neutral (no cross-bucket leak): "
        "feedbackCount=0, learnedAdjustment=0, effectiveImportance=0",
        status == 200
        and pa_ai is not None
        and pa_ai.get("feedbackCount") == 0
        and pa_ai.get("learnedAdjustment") == 0
        and pa_ai.get("effectiveImportance") == 0,
    )

    total = len(results)
    passed = sum(results)
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    run_tests()
