"""
test_version_diff.py

Core Gap Closure 2: the data behind the "View changes since vX" experience.

The word-level diff itself is a pure UI-layer helper, unit-tested in
src/lib/diff/word-diff.test.ts. This file proves the API contract the UI
depends on:

  - GET /api/timeline/:id/versions exposes, for a real edited entry, the
    exact OLD snapshot content and the CURRENT content, so the UI can
    compare selected-historical -> current without inventing anything
  - initial v1 has NO Version row (no fabricated snapshot)
  - each edit archives the replaced content as one historical Version row
  - revert advances versionNumber forward and archives, never rewinds
  - after reverting to vN, "since vN" compares equal content (the UI's
    "No content differences." case)
  - repeatedly reading versions mutates nothing (no Version / AuditEvent /
    system_event / versionNumber change from reads)
  - GET /versions role matrix is unchanged (Staff/Clinician/Admin same
    clinic 200; Patient 404 on an internal entry; cross-clinic 403)

Black-box HTTP against a running dev server, same convention as
test_revision_history.py. Fixture: a generic Clinician-authored
clinician_note / sectionKey="summary" entry created via POST /api/timeline
(authorRole=Clinician, type=clinician_note -> isClinicianOverride is false
on every write, so this exercises only the plain revision path). The
fixture entry and the single system_event the revert produces are deleted
by exact id in a finally block via the same throwaway-tsx Prisma script the
rest of the suite uses. Canonical Patient A / Learning Patient rows are
never touched.

PHI-safe stdout: no printed line contains raw entry content — only case
labels, counts, versionNumbers, and opaque cuid ids.

Setup:
  1. npx tsx prisma/seed.ts
  2. dev server running (NIGHTINGALE_BASE_URL, default http://localhost:3000)

Run:
  NIGHTINGALE_BASE_URL=http://localhost:3100 python3 test_version_diff.py

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
    "staff_a": "staff.a@clinic-a.test",
    "admin_a": "admin.a@clinic-a.test",
    "clinician_b": "clinician.b@clinic-b.test",
    "patient_a": "patient.a@clinic-a.test",
}
PATIENT_A_ID = "synthetic-patient-a"
PATIENT_A_VISIBLE_ENTRY = "synthetic-entry-patient-summary"  # patient_session_summary

# Three distinct clinical-looking contents. No PHI.
C1 = "Plan: monitor symptoms and review in two weeks."
C2 = "Plan: monitor symptoms closely and review in two weeks."
C3 = "Plan: monitor symptoms closely and review in four weeks; advise sleep hygiene."

_token_cache = {}
results = []
created_entry_ids = []  # exact ids to delete in finally (fixture + revert system_event)


def _http_json(method, path, token=None, body=None):
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    if token:
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
    email = FIXTURE_EMAILS[actor_key]
    if email in _token_cache:
        return _token_cache[email]
    status, payload = _http_json("POST", "/api/auth/login", body={"email": email})
    if status != 200 or not isinstance(payload, dict) or not payload.get("token"):
        raise RuntimeError(f"Login failed for {email} (status {status}); seed the DB")
    _token_cache[email] = payload["token"]
    return payload["token"]


def check(name, condition):
    results.append(bool(condition))
    print(f"[{'PASS' if condition else 'FAIL'}] {name}")


def create_entry(actor_key, content, section_key):
    return _http_json(
        "POST", "/api/timeline", token=login(actor_key),
        body={"content": content, "patientId": PATIENT_A_ID,
              "type": "clinician_note", "sectionKey": section_key},
    )


def put_entry(actor_key, entry_id, content, expected_version):
    return _http_json(
        "PUT", f"/api/timeline/{entry_id}", token=login(actor_key),
        body={"content": content, "expectedVersion": expected_version},
    )


def revert_entry(actor_key, entry_id, target_version, expected_version):
    return _http_json(
        "POST", f"/api/timeline/{entry_id}/revert", token=login(actor_key),
        body={"targetVersion": target_version, "expectedVersion": expected_version},
    )


def get_versions(actor_key, entry_id):
    return _http_json("GET", f"/api/timeline/{entry_id}/versions", token=login(actor_key))


def timeline_ids_by_type(actor_key, patient_id):
    status, payload = _http_json(
        "GET", f"/api/patients/{patient_id}/timeline", token=login(actor_key)
    )
    if status != 200 or not isinstance(payload, list):
        raise RuntimeError(f"timeline list failed (status {status})")
    return {e["id"]: e.get("type") for e in payload if isinstance(e, dict)}


def snapshot_content(versions_payload, version_number):
    for v in versions_payload.get("versions", []):
        if v.get("versionNumber") == version_number:
            return v.get("content")
    return None


# ─── Throwaway-tsx cleanup (exact-id only) — mirrors test_revision_history.py ──
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
    const a = await prisma.auditEvent.deleteMany({ where: { timelineEntryId: { in: entryIds } } });
    const v = await prisma.version.deleteMany({ where: { timelineEntryId: { in: entryIds } } });
    const e = await prisma.timelineEntry.deleteMany({ where: { id: { in: entryIds } } });
    console.log(JSON.stringify({ ok: true, deletedAudits: a.count, deletedVersions: v.count, deletedEntries: e.count }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(JSON.stringify({ ok: false, code: e && e.code })); process.exit(1); });
"""

# Read-only, metadata-only probe: counts for this entry. Never selects content.
PROBE_TEMPLATE = """\
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "__PRISMA_CLIENT_IMPORT__";
const entryIds = __ENTRY_IDS_JSON__;
async function main() {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const id = entryIds[0];
    const versions = await prisma.version.count({ where: { timelineEntryId: id } });
    const audits = await prisma.auditEvent.count({ where: { timelineEntryId: id } });
    const entry = await prisma.timelineEntry.findUnique({ where: { id }, select: { versionNumber: true } });
    console.log(JSON.stringify({ ok: true, versions, audits, versionNumber: entry ? entry.versionNumber : null }));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(JSON.stringify({ ok: false, code: e && e.code })); process.exit(1); });
"""


def _run_tsx(template, entry_ids, name):
    root = os.path.dirname(os.path.abspath(__file__))
    client_path = os.path.join(root, "src", "generated", "prisma", "client")
    try:
        with tempfile.TemporaryDirectory(prefix="nightingale-version-diff-") as tmp:
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


def run_tests():
    print(f"Target: {BASE_URL}\n")

    # ─── v1: create, no historical snapshot ─────────────────────────────
    status, created = create_entry("clinician_a", C1, "summary")
    entry_id = created.get("id") if isinstance(created, dict) else None
    if entry_id:
        created_entry_ids.append(entry_id)
    check("S1. POST /timeline -> 201, versionNumber 1", status == 201 and created.get("versionNumber") == 1)
    if not entry_id:
        print("FATAL: fixture creation failed")
        return

    status, v = get_versions("clinician_a", entry_id)
    check(
        "S2. v1 has NO Version row: versions == [], currentVersionNumber 1, "
        "currentContent == created content",
        status == 200
        and v.get("versions") == []
        and v.get("currentVersionNumber") == 1
        and v.get("currentContent") == C1,
    )

    # ─── edit v1 -> v2 ─────────────────────────────────────────────────
    status, r2 = put_entry("clinician_a", entry_id, C2, 1)
    check("S3. PUT (expectedVersion 1) -> 200, versionNumber 2", status == 200 and r2.get("versionNumber") == 2)

    status, v = get_versions("clinician_a", entry_id)
    check(
        "S4. one historical snapshot: versionNumber 1 holds the ORIGINAL "
        "content; current is now v2 content",
        status == 200
        and [row.get("versionNumber") for row in v.get("versions", [])] == [1]
        and snapshot_content(v, 1) == C1
        and v.get("currentVersionNumber") == 2
        and v.get("currentContent") == C2,
    )

    # ─── edit v2 -> v3 ─────────────────────────────────────────────────
    status, r3 = put_entry("clinician_a", entry_id, C3, 2)
    check("S5. PUT (expectedVersion 2) -> 200, versionNumber 3", status == 200 and r3.get("versionNumber") == 3)

    status, v = get_versions("clinician_a", entry_id)
    check(
        "S6. two historical snapshots in ascending order (v1 then v2), each "
        "holding the content it had before being replaced",
        status == 200
        and [row.get("versionNumber") for row in v.get("versions", [])] == [1, 2]
        and snapshot_content(v, 1) == C1
        and snapshot_content(v, 2) == C2
        and v.get("currentVersionNumber") == 3
        and v.get("currentContent") == C3,
    )

    # ─── the exact inputs the "View changes since v1" UI consumes ──────
    old_for_since_v1 = snapshot_content(v, 1)
    current = v.get("currentContent")
    check(
        "S7. 'View changes since v1' compares OLD=snapshot v1 -> CURRENT=v3 "
        "content, and they genuinely differ",
        old_for_since_v1 == C1 and current == C3 and old_for_since_v1 != current,
    )
    check(
        "S8. 'View changes since v2' compares OLD=snapshot v2 -> CURRENT=v3",
        snapshot_content(v, 2) == C2 and current == C3 and C2 != C3,
    )

    # ─── revert to v1 content -> v4 (forward, archives, never rewinds) ──
    before_ids = timeline_ids_by_type("clinician_a", PATIENT_A_ID)
    status, r4 = revert_entry("clinician_a", entry_id, 1, 3)
    check("S9. revert to targetVersion 1 (expectedVersion 3) -> 200, versionNumber 4 (forward)",
          status == 200 and r4.get("versionNumber") == 4)
    after_ids = timeline_ids_by_type("clinician_a", PATIENT_A_ID)
    new_sysevents = [i for i in after_ids if i not in before_ids and after_ids.get(i) == "system_event"]
    for i in new_sysevents:
        created_entry_ids.append(i)
    check("S10. revert produced exactly one new system_event", len(new_sysevents) == 1)

    status, v = get_versions("clinician_a", entry_id)
    check(
        "S11. revert archived the pre-revert content: 3 snapshots now "
        "(v1, v2, v3), current is v4 and its content equals the v1 snapshot",
        status == 200
        and [row.get("versionNumber") for row in v.get("versions", [])] == [1, 2, 3]
        and snapshot_content(v, 3) == C3
        and v.get("currentVersionNumber") == 4
        and v.get("currentContent") == C1,
    )
    check(
        "S12. after reverting to v1, 'View changes since v1' compares equal "
        "content -> UI shows 'No content differences.'",
        snapshot_content(v, 1) == v.get("currentContent"),
    )
    check(
        "S13. version identity is not content identity: current is v4 even "
        "though its content matches the v1 snapshot",
        v.get("currentVersionNumber") == 4,
    )

    # ─── viewing / reading never mutates ──────────────────────────────
    probe_before, err = _run_tsx(PROBE_TEMPLATE, [entry_id], "probe.ts")
    for _ in range(3):
        get_versions("clinician_a", entry_id)
        get_versions("staff_a", entry_id)
    probe_after, err2 = _run_tsx(PROBE_TEMPLATE, [entry_id], "probe.ts")
    check(
        "S14. repeated GET /versions mutates nothing: Version count, "
        "AuditEvent count, and versionNumber all unchanged",
        probe_before is not None and probe_after is not None
        and probe_before == probe_after
        and probe_after.get("versions") == 3
        and probe_after.get("versionNumber") == 4,
    )
    if err or err2:
        print(f"   (probe note: {err or err2})")

    # ─── GET /versions role matrix (unchanged contract) ──────────────
    check("S15. Staff A (same clinic) GET /versions -> 200", get_versions("staff_a", entry_id)[0] == 200)
    check("S16. Admin A (same clinic) GET /versions -> 200", get_versions("admin_a", entry_id)[0] == 200)
    check("S17. Clinician B (cross-clinic) GET /versions -> 403", get_versions("clinician_b", entry_id)[0] == 403)
    check("S18. Patient A GET /versions on this internal entry -> 404 (existence hidden)",
          get_versions("patient_a", entry_id)[0] == 404)
    check("S19. Patient A GET /versions on a patient-visible entry -> 200 (contract unchanged)",
          get_versions("patient_a", PATIENT_A_VISIBLE_ENTRY)[0] == 200)


if __name__ == "__main__":
    try:
        run_tests()
    except Exception as e:  # noqa: BLE001 - never crash the run
        print(f"ERROR during test run: {type(e).__name__}: {e}")
        results.append(False)
    finally:
        print("\n-- Cleanup --")
        if not created_entry_ids:
            print("(nothing to clean up)")
        else:
            payload, err = _run_tsx(CLEANUP_TEMPLATE, created_entry_ids, "cleanup.ts")
            ok = payload is not None and payload.get("ok")
            check("cleanup. fixture entry + revert system_event deleted by exact id", ok)
            if err:
                print(f"   cleanup error: {err}")
            else:
                print(f"   {json.dumps(payload)}")

    total = len(results)
    passed = sum(1 for r in results if r)
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if passed == total else 1)
