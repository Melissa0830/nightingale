# Nightingale 72-Hour Build Challenge — Final Execution Plan

> Deadline: **Friday, August 28, 2026, 5:30 PM SGT/MYT**
> This version builds on the "Full Coverage" draft after reviewing external suggestions line-by-line. Low-cost, high-value precision fixes were adopted, while the **full Self-Learning formula was deliberately scaled down** to avoid crowding out core feature time (see "This Round's Review & Trade-offs" at the end).

---

## Core Principle (applies throughout)

> **The next layer cannot be built on top of a broken layer below it. Core requirements (14 points) always take priority over Bonus (10 points).**

Commit after finishing each feature block.

---

## Three-Day Overview

| Day | Daytime Work | Sleep | Goal |
|---|---|---|---|
| Day 1 | ~16.5 hours | At least 6 hours | Scope, tech stack, schema (with Clinic + section_key), DB+API, RBAC (with multi-clinic + admin cross-clinic test) |
| Day 2 | ~22 hours | At least 5 hours | Timeline, Provenance (with quoted_text precise anchoring), Inline Collaboration, Glance View (with Open Actions), Version (with diff display), AI Scribe (3 types, full provenance), Conflict rules (including patient memory), PHI (central gateway) |
| Day 3 | ~20.5 hours (last 2 hours fully cleared) | — | Self-Learning (simplified), latency measurement, TLS notes, clean-logs documentation, integration tests (including section-level), bug fixing, README, brief (with Assumptions section), demo (with Scenario C), submission |

> Day 2 is the heaviest day in the whole plan. If it truly can't be completed in time, priority order is: **RBAC > Timeline > Provenance > Inline Collaboration > Version (do revert first, diff can wait if there's slack) > Glance View (basic version first, Open Actions can just be a simple list)**.

---

## Day 1: Planning + Foundations

### Hour 0–2 | Scope Document
```text
CORE (must-do, covers all 14 points)
[ ] RBAC (role + multi-clinic isolation, server-side)
[ ] Timeline (all 3 AI-note types have provenance)
[ ] Inline Collaboration (comments/resolve/@mention/assign)
[ ] Glance View (risk + Open Actions + 10-second readability)
[ ] Provenance (entry-level + quoted_text precise anchoring)
[ ] Version Control (revert + view-changes-since + simple diff display)
[ ] PHI Redaction (name/IC/phone, routed through a central gateway function)
[ ] Conflict handling (AI + patient memory vs. clinician, clinician wins)
[ ] Latency measurement
[ ] TLS/encryption notes + clean-logs policy

SIMPLIFIED (Bonus — a working demonstration is enough, not full completeness)
[ ] Self-Learning: weight + recency + risk_level, three factors (not the full 5-factor formula)
[ ] Data decay: architectural explanation only

NOT IMPLEMENTED
[ ] Voice capture (explicitly dropped, document in README)
```

---

### Hour 2–4 | Tech Stack & Project Setup
```text
Next.js + TypeScript + PostgreSQL + Prisma
```
Create `ATTRIBUTION.txt` now and log each dependency as you add it.

---

### Hour 4–6.5 | Database Schema
```text
Clinic
  │
  ├── User (role, clinic_id)
  │
  └── Patient (clinic_id)
         │
         └── TimelineEntry
                (author_role, author_id, type, content, section_key,
                 provenance_type, provenance_id, created_at)
                │
                ├── Comment (thread_id, resolved: bool, mentions[], assigned_to)
                ├── Version (content_snapshot, editor_id, created_at)
                ├── Highlight (entry_id, quoted_text, risk_reason, importance_score)
                └── AI_ScribedNote (session_id, source_type, redacted: bool)
```

**Two key new fields added:**
- `section_key` (enum: summary/plan/medication/staff_note) → gives the concurrent-edit test something real to check
- `provenance_type` + `provenance_id` (unified format) → ensures all three AI-note types (doctor/nurse/patient) carry provenance, not just patient sessions

**Definition of done**: ER diagram complete, with `section_key` and provenance fields both clearly scoped.

---

### Hour 6.5–10.5 | DB + Basic API
```text
GET  /patients
GET  /patients/:id
GET  /patients/:id/timeline
POST /timeline
PUT  /timeline/:id
```

---

### Hour 10.5–15 | RBAC (with multi-clinic isolation)
| Action | Doctor | Nurse | Patient | Admin |
|---|---:|---:|---:|---:|
| Read full timeline | ✓ | ✓ | ✗ | ✓ |
| Read patient-facing summary | ✓ | ✓ | ✓ | ✓ |
| Write clinician_section | ✓ | ✗ | ✗ | ✗ |
| Write staff_notes | Read-only | ✓ | ✗ | ✗ |
| Read internal comments / raw AI notes | ✓ | ✓ | ✗ | ✓ |

```text
IF request.user.clinic_id != target_patient.clinic_id
THEN 403, regardless of role (including Admin)
```

Patient view: the backend returns a pre-filtered summary directly — never rely on the frontend to hide fields.

---

### Hour 15–17.5 | RBAC Automated Tests
```text
test_rbac_scope.py

✓ Doctor edits doctor note → 200
✓ Nurse edits doctor note → 403
✓ Patient reads internal comment → 403
✓ Clinician in Clinic A accesses a Clinic B patient → 403
✓ Admin accesses a different clinic → 403          ← newly added
```

---

### Hour 17.5–23.5 | Sleep (at least 6 hours recommended)

---

## Day 2: Core Features (~22 hours)

### +Hour 0–4 | Timeline
```text
timestamp | author_role | entry_type | section_key | content
```

---

### +Hour 4–8 | Provenance (with quoted_text precise anchoring)
```text
Highlight.quoted_text = "worsening chest pain"
entry_id → TimelineEntry.id

Click highlight → jump to entry → match quoted_text in the source text → apply yellow highlight
```
Skip offset-based tracking (it breaks easily after edits); the simplified text-match approach still achieves "jump to the exact span."

Each highlight includes a `risk_reason`.

---

### +Hour 8–10.5 | Inline Collaboration
```text
Comment
├── entry_id
├── author_id
├── content (simple string parsing for @mentions)
├── resolved: bool
└── assigned_to
```
```text
┌─ TimelineEntry: "BP 150/90..." ─────────┐
│ 💬 Staff: Needs medication review        │
│    @Dr.Chen please confirm               │
│    [ Resolve ]  [ Assign to: Dr.Chen ▾ ] │
└──────────────────────────────────────────┘
```

---

### +Hour 10.5–14.5 | Glance View (with Open Actions)
```text
TOP / GLANCE — John Chen, 65/Male

⚠ CRITICAL
Chest pain worsening

OPEN ACTIONS
[ ] Needs lab order
[ ] Waiting nurse follow-up
[ ] Medication review — Assigned to Dr.Chen

Allergies: Penicillin
Medications: Warfarin, Metformin
Recent Change: BP increased
Last Update: 2 hours ago
```
`OPEN ACTIONS` maps directly to unresolved Comment/assignment data — it's not a separate system, just another view of the Inline Collaboration data.

**Definition of done**: fully readable, including open actions, within 10 seconds.

---

### +Hour 14.5–15.5 | Lunch / Buffer

---

### +Hour 15.5–19 | Version Control (with diff display)
```text
Before saving, copy current content into the Version table → then update TimelineEntry
GET /timeline/:id/changes?since=<timestamp>
```

**Add a simple diff (computed in the UI layer, no DB schema change):**
```diff
Version 2 → Version 3
- Patient reports mild chest pain.
+ Patient reports worsening chest pain.
```
Use an off-the-shelf text-diff library (e.g., the `diff` npm package) to compute the difference between two snapshots on the frontend — the database still only stores full snapshots.

---

### +Hour 19–21 | AI Scribe (3 types, all with provenance) + Conflict Rules (including patient memory)
```text
type: ai_doctor_consult_summary   provenance_type: doctor_consult   provenance_id: session_001
type: ai_nurse_consult_summary    provenance_type: nurse_consult    provenance_id: session_004
type: ai_patient_session_summary  provenance_type: patient_session  provenance_id: session_018
```

**Broadened conflict rule (previously AI-only, now includes patient memory):**
```text
IF clinician edits a section that overlaps with
   (AI-scribed content OR patient-provided content)
THEN clinician's version takes precedence
AND log a "conflict_flagged" event on that entry
```

---

### +Hour 21–22 | PHI Redaction (central gateway function)
Instead of writing regex separately in each spot, wrap it into one shared function that every piece of content going to the LLM must pass through first:
```text
function redactPHI(text) {
  // Uniformly handles Name, IC/ID, Phone
  return redacted_text;
}

// Before any LLM call:
const safeText = redactPHI(rawInput);
```
Example:
```text
Input:  John Wang, IC: S1234567A, Phone: 0912-345-678
Output: [NAME], IC: [ID_NUMBER], Phone: [PHONE]
```

---

### +Hour 22 onward | Sleep (at least 5 hours recommended)
Before Day 2 ends, check the Scope table — any gaps go to the top of Day 3 morning.

---

## Day 3: Wrap-Up (~20.5 hours, last 2 hours fully cleared)

### +Hour 0–1.5 | Fill Any Remaining Core Gaps

---

### +Hour 1.5–2.5 | Latency Measurement
Load the glance view 10 times in DevTools, take the P95, and write it into the brief.

---

### +Hour 2.5–3 | TLS/Encryption Notes + Clean Logs Policy
```text
Transit: HTTPS (local dev cert / hosting-provided TLS after deployment)
At Rest: describe the encryption approach a production deployment would use (architectural explanation is sufficient)

Logging Policy (document in README):
Allowed: user_id, entry_id, action, timestamp, version_id
Not logged: patient name, raw note content, AI prompt content, phone, IC/ID
```

---

### +Hour 3–5 | Self-Learning (simplified 3-factor version, NOT the full 5-factor formula)
```text
importance_score = highlight_count × 1.0
                  + recency_bonus (more recent entries score higher)
                  + risk_level_tag (extra points if flagged high risk)
```
Provide the most basic accept/reject UI (a single button that adjusts the weight on click) — **skip the full accept +2 / reject -1 scoring complexity**; keep it simple and demoable.

State honestly in the brief:
> "This is a simplified rule-based prioritization combining highlight frequency, recency, and explicit risk tags — not a full multi-signal learned model, prioritized to keep core requirements stable within the time budget."

---

### +Hour 5–5.5 | Bonus Decision Gate
Only consider a data-decay architectural explanation (no code) once Core is stable. Voice capture remains dropped.

---

### +Hour 5.5–10 | Full User-Flow Walkthrough + Automated Tests (including section-level)
```text
Login as Doctor → Glance View → click a highlight, jump to the exact span (Provenance)
→ add a comment + @mention → edit the PLAN section → new Version → view diff → Revert
→ Login as Nurse in the same clinic → unauthorized edit → 403
→ Login as Clinician in a different clinic → access denied → 403
→ Login as Admin in a different clinic → access denied → 403        ← newly added
```

Finish the required test files:
```text
test_rbac_scope.py             Role permissions + multi-clinic (incl. Admin) + section-level write permission
test_revision_history.py       Version increments, revert restores state, audit log shows metadata
test_highlight_provenance.py   provenance_pointer resolves; quoted_text locates the source span
test_concurrent_edits.py       Doctor edits PLAN while Nurse edits STAFF_NOTE concurrently, no overwrite
                                (verified using section_key, not just described as a rule)
test_self_learning_importance.py  Conceptual description + assertion that weight/recency/risk actually affect ordering
```

---

### +Hour 10–12 | Bug Fixing
```text
P0: breaks the demo → must fix
P1: functional but ugly → fix if time allows
P2: minor details → skip, note under Known Limitations
```

---

### +Hour 12–13.5 | README + ATTRIBUTION.txt
```text
## Overview / Architecture / Tech Stack / Setup & Run
## Database Schema (Clinic + section_key design)
## RBAC (role + multi-clinic isolation)
## Inline Collaboration
## Provenance (entry + quoted_text anchoring)
## Versioning (with diff display)
## PHI Redaction (central gateway function explained)
## Conflict Resolution (AI + patient memory)
## Encryption (TLS + at-rest)
## Logging Policy (clean logs)
## Self-Learning (honestly state the simplification)
## Latency (measurement method and results)
## Testing / Assumptions / Trade-offs & Known Limitations
```

---

### +Hour 13.5–15 | Technical Brief (2–3 pages, with an Assumptions section)

**Page 1 — Problem & First-Principles Design**
- What information needs to be trusted?
- What needs immediate attention?
- What can the AI suggest, but not own the decision on?
- Why does clinician confirmation matter?

**Page 2 — Architecture & Data Schema**
(Include the ER diagram)

**Page 3 — Assumptions, Trade-offs & Validation**

| Feature | Decision |
|---|---|
| RBAC | Fully implemented, including multi-clinic + Admin isolation |
| Inline Collaboration | Implemented |
| Provenance | Entry + quoted_text precise anchoring |
| Version | Full snapshot + UI-layer diff display |
| AI Scribe | 3 synthetic-data types, all with provenance |
| Conflict handling | Covers both AI and patient memory |
| Self-Learning | Simplified 3-factor version, not the full 5-factor formula (explicitly noted) |
| Encryption | Architectural explanation |
| Voice capture | Not implemented — a deliberate trade-off given time constraints |

---

### +Hour 15–17 | Demo Recording (covering Scenarios A/B/C)
```text
1. Login as Doctor → Glance View (readable in 10 seconds, including Open Actions)
2. Click a highlight → jump to the exact source span (Provenance)
3. Staff adds a note + @mentions the clinician (Scenario B)
4. Clinician marks a highlight sourced from an AI note + edits the PLAN section
5. View Version History → show the diff → Revert (including audit log)
6. Switch to a Nurse in the same clinic → unauthorized edit → 403
7. Switch to a Clinician in a different clinic → access denied
8. Show all 3 AI Scribe note types (each with provenance) + PHI redaction before/after
9. Longitudinal Context (Scenario C): show entries from Apr 2025 and Aug 2026,
   explaining "recent, unresolved, clinician-confirmed items are prioritized over older data,
   and how self-learning influences that ordering"
10. Close with the architecture diagram
```

---

### Final 2 Hours | Mandatory Freeze — No New Features
```text
✓ git push / clear test database / seed clean demo data
✓ Run all tests, confirm everything passes
✓ Confirm README, brief, and ATTRIBUTION.txt are all in the repo
✓ Confirm email subject line and recipients
✓ Submit early
```

---

## This Round's Review & Trade-offs

After checking the external suggestion list item by item, the following were **adopted directly** (low cost, high scoring value): Open Actions, consistent provenance across all 3 AI-note types, diff display, extending the conflict rule to include patient memory, documenting the clean-logs policy, restructuring the brief, the Admin cross-clinic test, and the Scenario C demo segment.

**Partially adopted, but simplified:**
- Exact-span provenance → implemented via `quoted_text` string matching instead of a full offset-tracking system
- Section-level concurrency → added a single `section_key` field rather than a separate table

**Deliberately scaled down, not fully adopted:**
- The full 5-factor weighted Self-Learning formula + complete accept/reject UI → this is explicitly listed as a **Bonus** item in the brief, and the brief itself allows the corresponding test to be "conceptual." With Day 2 already at ~22 hours of work, pushing this further would crowd out time needed to finish and test the **Core requirements (14 points)**. A simplified 3-factor version was adopted instead, with the trade-off stated honestly in the brief — this is more consistent with the brief's own emphasis on "clarity over polish" than a rushed, poorly-executed complex formula would be.
