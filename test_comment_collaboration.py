"""
test_comment_collaboration.py

Core Gap Closure 3: comment mentions + assignment, and the read-only
collaborator lookup that backs the selectors.

Black-box HTTP against a running dev server, same convention as
test_version_diff.py / test_revision_history.py. All mutations happen on a
temporary Clinician-authored clinician_note fixture created via
POST /api/timeline; the fixture is deleted by exact id in a finally block
via the same throwaway-tsx Prisma script the rest of the suite uses.
Canonical Patient A / Learning Patient rows are never touched.

Covers:
  - GET /api/collaborators RBAC matrix + zero cross-clinic leakage +
    response-field minimisation (new endpoint, independent surface)
  - POST comment: valid same-clinic Staff/Clinician mention + assignee
    persist; cross-clinic id rejected; unknown id rejected; duplicate
    mentions normalised; all rejections share one opaque 400
  - PATCH comment: reassign, clear assignment, resolve, reopen; mentions
    unchanged across all of it
  - Patient denied comments; Admin comment mutation denied; Staff/Clinician
    unchanged

Setup:
  1. npx tsx prisma/seed.ts
  2. dev server running (NIGHTINGALE_BASE_URL, default http://localhost:3000)

Run:
  NIGHTINGALE_BASE_URL=http://localhost:3100 python3 test_comment_collaboration.py

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

EMAILS = {
    "clinician_a": "clinician.a@clinic-a.test",
    "staff_a": "staff.a@clinic-a.test",
    "admin_a": "admin.a@clinic-a.test",
    "clinician_b": "clinician.b@clinic-b.test",
    "patient_a": "patient.a@clinic-a.test",
}
PATIENT_A_ID = "synthetic-patient-a"
PATIENT_A_VISIBLE_ENTRY = "synthetic-entry-patient-summary"
ENTRY_PLAN_ID = "synthetic-entry-plan"

USER_CLINICIAN_A = "synthetic-user-clinician-a"
USER_STAFF_A = "synthetic-user-staff-a"
USER_ADMIN_A = "synthetic-user-admin-a"
USER_CLINICIAN_B = "synthetic-user-clinician-b"

_tok = {}
results = []
created_entry_ids = []


def _http(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{BASE_URL}{path}", data=data, headers=headers, method=method)
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
    s, p = _http("POST", "/api/auth/login", body={"email": EMAILS[key]})
    if s != 200 or not isinstance(p, dict) or not p.get("token"):
        raise RuntimeError(f"login failed for {key} ({s})")
    _tok[key] = p["token"]
    return p["token"]


def check(name, cond):
    results.append(bool(cond))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}")


def collaborators(key):
    return _http("GET", "/api/collaborators", token=login(key))


def post_comment(key, entry_id, body):
    return _http("POST", f"/api/timeline/{entry_id}/comments", token=login(key), body=body)


def get_comments(key, entry_id):
    return _http("GET", f"/api/timeline/{entry_id}/comments", token=login(key))


def patch_comment(key, comment_id, body):
    return _http("PATCH", f"/api/comments/{comment_id}", token=login(key), body=body)


CLEANUP_TEMPLATE = """\
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "__PRISMA_CLIENT_IMPORT__";
const entryIds = __ENTRY_IDS_JSON__;
async function main() {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    if (entryIds.length === 0) { console.log(JSON.stringify({ ok: true, deleted: 0 })); return; }
    const c = await prisma.comment.deleteMany({ where: { timelineEntryId: { in: entryIds } } });
    const a = await prisma.auditEvent.deleteMany({ where: { timelineEntryId: { in: entryIds } } });
    const e = await prisma.timelineEntry.deleteMany({ where: { id: { in: entryIds } } });
    console.log(JSON.stringify({ ok: true, deletedComments: c.count, deletedAudits: a.count, deletedEntries: e.count }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(JSON.stringify({ ok: false, code: e && e.code })); process.exit(1); });
"""


def _run_tsx(template, entry_ids, name):
    root = os.path.dirname(os.path.abspath(__file__))
    client_path = os.path.join(root, "src", "generated", "prisma", "client")
    try:
        with tempfile.TemporaryDirectory(prefix="nightingale-comment-collab-") as tmp:
            rel = os.path.relpath(os.path.realpath(client_path), start=os.path.realpath(tmp)).replace(os.sep, "/")
            if not rel.startswith("."):
                rel = "./" + rel
            script = template.replace("__PRISMA_CLIENT_IMPORT__", rel).replace("__ENTRY_IDS_JSON__", json.dumps(entry_ids))
            path = os.path.join(tmp, name)
            with open(path, "w", encoding="utf-8") as f:
                f.write(script)
            env = {**os.environ, "NODE_PATH": os.path.join(root, "node_modules")}
            proc = subprocess.run(["npx", "tsx", path], cwd=root, capture_output=True, text=True, timeout=60, env=env)
    except (subprocess.TimeoutExpired, OSError) as e:
        return None, f"subprocess failed: {type(e).__name__}"
    lines = (proc.stdout or "").strip().splitlines()
    try:
        payload = json.loads(lines[-1]) if lines else None
    except json.JSONDecodeError:
        payload = None
    if proc.returncode != 0 or not isinstance(payload, dict) or not payload.get("ok"):
        return None, f"script exited {proc.returncode}"
    return payload, None


def run():
    print(f"Target: {BASE_URL}\n")

    # ─── GET /api/collaborators — independent RBAC matrix ───────────────
    print("-- GET /api/collaborators RBAC matrix --")
    s, ca = collaborators("clinician_a")
    ca_ids = sorted(u["id"] for u in ca) if isinstance(ca, list) else None
    check("R1. Clinician A -> 200, exactly the same-clinic Staff+Clinician set",
          s == 200 and ca_ids == sorted([USER_CLINICIAN_A, USER_STAFF_A]))
    check("R2. rows carry only {id,name,role} — no email/password/patientId",
          isinstance(ca, list) and all(set(u.keys()) == {"id", "name", "role"} for u in ca))
    check("R3. no Admin and no Patient in the collaborator set",
          isinstance(ca, list) and all(u["role"] in ("Staff", "Clinician") for u in ca)
          and USER_ADMIN_A not in ca_ids)

    s, sa = collaborators("staff_a")
    check("R4. Staff A -> 200, same Clinic A set",
          s == 200 and isinstance(sa, list) and sorted(u["id"] for u in sa) == sorted([USER_CLINICIAN_A, USER_STAFF_A]))

    s, aa = collaborators("admin_a")
    check("R5. Admin A -> 200 (needed to resolve names on read-only view), same Clinic A set",
          s == 200 and isinstance(aa, list) and sorted(u["id"] for u in aa) == sorted([USER_CLINICIAN_A, USER_STAFF_A]))

    s, pa = collaborators("patient_a")
    check("R6. Patient A -> 403, no body list", s == 403 and not isinstance(pa, list))

    s, cb = collaborators("clinician_b")
    cb_ids = [u["id"] for u in cb] if isinstance(cb, list) else None
    check("R7. Clinician B -> 200, ONLY Clinic B collaborators (my-clinic scope)",
          s == 200 and cb_ids == [USER_CLINICIAN_B])
    check("R8. ZERO Clinic A user leakage to Clinician B",
          isinstance(cb, list) and USER_CLINICIAN_A not in cb_ids and USER_STAFF_A not in cb_ids
          and USER_ADMIN_A not in cb_ids)

    # ─── temporary fixture entry ──────────────────────────────────────
    s, created = _http("POST", "/api/timeline", token=login("clinician_a"),
                       body={"content": "Collaboration fixture note.", "patientId": PATIENT_A_ID,
                             "type": "clinician_note", "sectionKey": "summary"})
    entry_id = created.get("id") if isinstance(created, dict) else None
    if entry_id:
        created_entry_ids.append(entry_id)
    check("F1. temporary fixture entry created", s == 201 and entry_id)
    if not entry_id:
        return

    # ─── POST comment with valid mention + assignee ───────────────────
    print("\n-- POST comment: mentions + assignment --")
    s, c = post_comment("clinician_a", entry_id, {
        "content": "Please review the plan.",
        "mentions": [USER_STAFF_A, USER_STAFF_A, USER_CLINICIAN_A],  # duplicate on purpose
        "assignedToId": USER_STAFF_A,
    })
    cid = c.get("id") if isinstance(c, dict) else None
    check("A1. same-clinic Staff+Clinician mention & Staff assignee accepted -> 201", s == 201 and cid)
    check("A2. duplicate mention id normalised (stored once each, order preserved)",
          isinstance(c, dict) and c.get("mentions") == [USER_STAFF_A, USER_CLINICIAN_A])
    check("A3. assignment persisted on create", isinstance(c, dict) and c.get("assignedToId") == USER_STAFF_A)

    s, rows = get_comments("clinician_a", entry_id)
    got = next((x for x in rows if x["id"] == cid), None) if isinstance(rows, list) else None
    check("A4. GET returns the comment with mentions + assignee intact",
          got is not None and got["mentions"] == [USER_STAFF_A, USER_CLINICIAN_A]
          and got["assignedToId"] == USER_STAFF_A)

    # ─── rejection cases: all opaque 400, nothing persisted ──────────
    print("\n-- POST comment: rejection cases --")
    s, _ = post_comment("clinician_a", entry_id, {"content": "x", "assignedToId": USER_CLINICIAN_B})
    check("B1. cross-clinic assignee -> 400 (not silently accepted)", s == 400)
    s, _ = post_comment("clinician_a", entry_id, {"content": "x", "assignedToId": "no-such-user-id"})
    check("C1. unknown assignee -> 400", s == 400)
    s, _ = post_comment("clinician_a", entry_id, {"content": "x", "mentions": [USER_CLINICIAN_B]})
    check("D1. cross-clinic mention -> 400 (not persisted)", s == 400)
    s, _ = post_comment("clinician_a", entry_id, {"content": "x", "mentions": ["no-such-user-id"]})
    check("D2. unknown mention -> 400", s == 400)
    s, _ = post_comment("clinician_a", entry_id, {"content": "x", "assignedToId": USER_ADMIN_A})
    check("E1. Admin assignee -> 400 (Admin is not collaboration-capable)", s == 400)

    s, rows = get_comments("clinician_a", entry_id)
    check("B2. none of the rejected attempts created a comment (still exactly 1)",
          isinstance(rows, list) and len(rows) == 1)

    # ─── PATCH: reassign / clear / resolve / reopen; mentions stable ──
    print("\n-- PATCH: reassign / clear / resolve / reopen --")
    s, u = patch_comment("clinician_a", cid, {"assignedToId": USER_CLINICIAN_A})
    check("P1. reassign to another same-clinic collaborator -> 200",
          s == 200 and u.get("assignedToId") == USER_CLINICIAN_A and u.get("mentions") == [USER_STAFF_A, USER_CLINICIAN_A])

    s, _ = patch_comment("clinician_a", cid, {"assignedToId": USER_CLINICIAN_B})
    check("P2. reassign to cross-clinic collaborator -> 400", s == 400)

    s, u = patch_comment("clinician_a", cid, {"assignedToId": None})
    check("P3. clear assignment (assignedToId: null) -> 200, now Unassigned, mentions intact",
          s == 200 and u.get("assignedToId") is None and u.get("mentions") == [USER_STAFF_A, USER_CLINICIAN_A])

    s, u = patch_comment("staff_a", cid, {"resolved": True})
    check("P4. Staff resolves -> 200, resolved true, mentions intact",
          s == 200 and u.get("resolved") is True and u.get("mentions") == [USER_STAFF_A, USER_CLINICIAN_A])

    s, u = patch_comment("clinician_a", cid, {"resolved": False})
    check("P5. reopen -> 200, resolved false, mentions still intact",
          s == 200 and u.get("resolved") is False and u.get("mentions") == [USER_STAFF_A, USER_CLINICIAN_A])

    # ─── role non-regression on the comment endpoints ───────────────
    print("\n-- comment endpoint role non-regression --")
    check("G1. Patient GET comments -> 403", get_comments("patient_a", ENTRY_PLAN_ID)[0] == 403)
    check("G2. Patient POST comment -> 403",
          post_comment("patient_a", PATIENT_A_VISIBLE_ENTRY, {"content": "x"})[0] == 403)
    check("H1. Admin POST comment -> 403", post_comment("admin_a", entry_id, {"content": "x"})[0] == 403)
    check("H2. Admin PATCH comment -> 403", patch_comment("admin_a", cid, {"resolved": True})[0] == 403)
    check("I1. Staff POST comment (same clinic) -> 201",
          post_comment("staff_a", entry_id, {"content": "Staff follow-up."})[0] == 201)
    check("I2. Clinician B PATCH a Clinic A comment -> 403",
          patch_comment("clinician_b", cid, {"resolved": True})[0] == 403)
    check("I3. Clinician B GET Clinic A comments -> 403",
          get_comments("clinician_b", entry_id)[0] == 403)


if __name__ == "__main__":
    try:
        run()
    except Exception as e:  # noqa: BLE001
        print(f"ERROR during test run: {type(e).__name__}: {e}")
        results.append(False)
    finally:
        print("\n-- Cleanup --")
        if not created_entry_ids:
            print("(nothing to clean up)")
        else:
            payload, err = _run_tsx(CLEANUP_TEMPLATE, created_entry_ids, "cleanup.ts")
            check("cleanup. fixture entry + its comments deleted by exact id", payload is not None and payload.get("ok"))
            print(f"   {json.dumps(payload) if payload else err}")

    total = len(results)
    passed = sum(1 for r in results if r)
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if passed == total else 1)
