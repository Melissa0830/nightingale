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
HL_X_LEX = "synthetic-highlight-learning-x-lex"
HL_Y_E = "synthetic-highlight-learning-y-e"
HL_Z_D = "synthetic-highlight-learning-z-d"
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

    # ─── Patient role cannot retrieve internal Highlights at all ─────────
    # Block 8.1: stronger than "no adaptive/riskFloor metadata" — the
    # Patient role is denied the endpoint outright (403, pre-query), so no
    # Highlight payload (base or derived) ever reaches a Patient.
    status, rows_patient = get_highlights("patient_a", PATIENT_A)
    check(
        "E3. Patient GET /highlights -> 403, no Highlight payload returned",
        status == 403 and not isinstance(rows_patient, list),
    )

    # ─── Phase 11: deterministic lexical-overlap grouping (live) ─────────
    x_d_pattern = find(rows_a, HL_X_D)
    check(
        "L1. identical-wording pending target -> matchMethod 'exact', "
        "lexicalOverlapScore 1",
        x_d_pattern is not None
        and x_d_pattern.get("matchMethod") == "exact"
        and x_d_pattern.get("lexicalOverlapScore") == 1,
    )
    x_lex = find(rows_a, HL_X_LEX)
    check(
        "L2. non-identical wording ('respiratory' inserted) -> matchMethod "
        "'lexical', overlap >= 0.6, attached to bucket X (adj +2)",
        x_lex is not None
        and x_lex.get("matchMethod") == "lexical"
        and x_lex.get("lexicalOverlapScore") is not None
        and x_lex.get("lexicalOverlapScore") >= 0.6
        and x_lex.get("acceptedCount") == 3
        and x_lex.get("rejectedCount") == 0
        and x_lex.get("learnedAdjustment") == 2
        and x_lex.get("matchedBucketRepresentativeId") == HL_X_A,
    )
    z_d = find(rows_a, HL_Z_D)
    check(
        "L3. bucket Z target still resolves to its own exact bucket "
        "(no lexical bleed from X/Y): matchMethod exact, adj -2",
        z_d is not None
        and z_d.get("matchMethod") == "exact"
        and z_d.get("learnedAdjustment") == -2,
    )

    # Safety-first ordering: the deterministic critical Highlight (adj 0) must
    # appear BEFORE every unrated Highlight, including the +2 bucket-X ones.
    ids_in_order = [h["id"] for h in rows_a]
    crit_id = "synthetic-highlight-learning-critical"
    crit = find(rows_a, crit_id)
    first_unrated_idx = next(
        (i for i, h in enumerate(rows_a) if h.get("riskFloor") == "unrated"), None
    )
    check(
        "L6. critical riskFloor Highlight (adj 0) sorts before every unrated "
        "Highlight, including bucket X at effectiveImportance +2",
        crit is not None
        and crit.get("riskFloor") == "critical"
        and crit.get("learnedAdjustment") == 0
        and ids_in_order.index(crit_id)
        < (first_unrated_idx if first_unrated_idx is not None else 10**9),
    )
    # Clinic B: the lexical demo highlight does not exist there; its bucket X
    # target stays -2 and cannot be pulled toward Clinic A's +2 evidence.
    s_b, rows_b = get_highlights("clinician_b", PATIENT_LEARNING_B)
    xb_d = find(rows_b, "synthetic-highlight-learning-xb-d") if isinstance(rows_b, list) else None
    check(
        "L4. lexical grouping is clinic-scoped: Clinic B bucket X target "
        "unaffected (still 0/3/-2)",
        xb_d is not None
        and xb_d.get("acceptedCount") == 0
        and xb_d.get("rejectedCount") == 3
        and xb_d.get("learnedAdjustment") == -2,
    )
    # Determinism: repeat the GET, identical grouping result.
    s_r, rows_r = get_highlights("clinician_a", PATIENT_LEARNING)
    x_lex_again = find(rows_r, HL_X_LEX) if isinstance(rows_r, list) else None
    check(
        "L5. repeated GET yields identical lexical resolution "
        "(method, score, representative)",
        x_lex_again is not None
        and x_lex_again.get("matchMethod") == x_lex.get("matchMethod")
        and x_lex_again.get("lexicalOverlapScore") == x_lex.get("lexicalOverlapScore")
        and x_lex_again.get("matchedBucketRepresentativeId")
        == x_lex.get("matchedBucketRepresentativeId"),
    )

    # ─── Phase 8: server-confirmed live recalculation + PATCH self-restore ─
    token_a = login("clinician_a")

    def xd_effective():
        s, rows = get_highlights("clinician_a", PATIENT_LEARNING)
        h = find(rows, HL_X_D) if isinstance(rows, list) else None
        return h.get("effectiveImportance") if h else None, h

    before_eff, before_h = xd_effective()
    check(
        "F0. bucket X pending target starts at effectiveImportance +2 "
        "(3 accepted / 0 rejected)",
        before_eff == 2 and before_h and before_h.get("acceptedCount") == 3
        and before_h.get("rejectedCount") == 0,
    )

    # flip one historical accept -> reject
    s_flip, _ = _http_json(
        "PATCH", f"/api/highlights/{HL_X_A}", token=token_a, body={"feedback": "rejected"}
    )
    mid_eff, mid_h = xd_effective()
    check(
        "F1. after flipping one accepted -> rejected, fresh GET shows "
        "2 accepted / 1 rejected / +1 (server recalculated, not client-guessed)",
        s_flip == 200
        and mid_h
        and mid_h.get("acceptedCount") == 2
        and mid_h.get("rejectedCount") == 1
        and mid_h.get("learnedAdjustment") == 1
        and mid_eff == 1,
    )
    check("F2. recalculation message would read '2 -> 1' (before != after)", before_eff == 2 and mid_eff == 1)

    # restore via PATCH (accepted <-> rejected is reversible; no reseed needed)
    s_restore, _ = _http_json(
        "PATCH", f"/api/highlights/{HL_X_A}", token=token_a, body={"feedback": "accepted"}
    )
    after_eff, after_h = xd_effective()
    check(
        "F3. restore accepted -> bucket X target back to 3 / 0 / +2",
        s_restore == 200
        and after_h
        and after_h.get("acceptedCount") == 3
        and after_h.get("rejectedCount") == 0
        and after_eff == 2,
    )

    # Phase 8 test B — below threshold: a feedback change that keeps the
    # review count under 3 must NOT move the adjustment. Flip Y_E
    # accepted -> rejected (bucket Y: 1 accepted + 1 rejected, still 2 reviews).
    s_ye, _ = _http_json(
        "PATCH", f"/api/highlights/{HL_Y_E}", token=token_a, body={"feedback": "rejected"}
    )
    s, rows_y = get_highlights("clinician_a", PATIENT_LEARNING)
    y_g_mid = find(rows_y, HL_Y_G) if isinstance(rows_y, list) else None
    check(
        "F4. below-threshold feedback change keeps reviewCount 2 and "
        "learnedAdjustment 0 ('feedback saved, unchanged')",
        s_ye == 200 and y_g_mid and y_g_mid.get("reviewCount") == 2
        and y_g_mid.get("learnedAdjustment") == 0
        and y_g_mid.get("effectiveImportance") == 0,
    )
    # restore Y_E rejected -> accepted (PATCH-reversible; fixture back to seed)
    s_ye2, _ = _http_json(
        "PATCH", f"/api/highlights/{HL_Y_E}", token=token_a, body={"feedback": "accepted"}
    )
    s, rows_y2 = get_highlights("clinician_a", PATIENT_LEARNING)
    y_e_final = find(rows_y2, HL_Y_E) if isinstance(rows_y2, list) else None
    check(
        "F5. bucket Y restored to seeded state (Y_E accepted again, adj 0)",
        s_ye2 == 200 and y_e_final and y_e_final.get("feedback") == "accepted"
        and y_e_final.get("learnedAdjustment") == 0,
    )

    total = len(results)
    passed = sum(results)
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    run_tests()
