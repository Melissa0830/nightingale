# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Nightingale** is a collaborative, longitudinal patient note clinic web app for healthcare providers, built as a 72-hour challenge. Deadline: **Friday, August 28, 2026, 5:30 PM SGT**.

**Scoring priority**: Core requirements (14 pts) always take priority over Bonus (10 pts). Never break a working lower layer to build the next.

## Tech Stack

- **Framework**: Next.js + TypeScript
- **Database**: PostgreSQL + Prisma ORM
- **Diff**: `diff` npm package (UI-layer only, DB stores full snapshots)
- Track every dependency added in `ATTRIBUTION.txt`

## Common Commands

Once the project is initialized:

```bash
# Development
npx next dev

# Database
npx prisma migrate dev
npx prisma generate
npx prisma studio

# Tests (Python)
python test_rbac_scope.py
python test_revision_history.py
python test_highlight_provenance.py
python test_concurrent_edits.py
python test_self_learning_importance.py
```

## Database Schema

```
Clinic
  ├── User (role, clinic_id)
  └── Patient (clinic_id)
        └── TimelineEntry
               (author_role, author_id, type, content, section_key,
                provenance_type, provenance_id, created_at)
               ├── Comment (thread_id, resolved: bool, mentions[], assigned_to)
               ├── Version (content_snapshot, editor_id, created_at)
               ├── Highlight (entry_id, quoted_text, risk_reason, importance_score)
               └── AI_ScribedNote (session_id, source_type, redacted: bool)
```

Key fields:
- `section_key` enum: `summary | plan | medication | staff_note` — enables concurrent edit testing
- `provenance_type` + `provenance_id` — all 3 AI note types must carry these fields

## Core Architecture Decisions

### RBAC (server-side only)
```
IF request.user.clinic_id != target_patient.clinic_id → 403 (including Admin)
```
| Action | Doctor | Nurse | Patient | Admin |
|---|---|---|---|---|
| Read full timeline | ✓ | ✓ | ✗ | ✓ |
| Write clinician_section | ✓ | ✗ | ✗ | ✗ |
| Write staff_notes | Read-only | ✓ | ✗ | ✗ |
| Read internal comments | ✓ | ✓ | ✗ | ✓ |

Patient view must be pre-filtered on the backend — never rely on frontend to hide fields.

### Provenance
Use `quoted_text` string matching (not offset-based tracking). Click a highlight → match `quoted_text` in the source `TimelineEntry` → apply yellow highlight. Each highlight requires a `risk_reason`.

### Version Control
Before saving, copy current content into the `Version` table, then update `TimelineEntry`. Diff is computed in the UI layer using the `diff` npm package — no DB schema change needed.

### AI Scribe (3 types, all with provenance)
```
ai_doctor_consult_summary   → provenance_type: doctor_consult
ai_nurse_consult_summary    → provenance_type: nurse_consult
ai_patient_session_summary  → provenance_type: patient_session
```

### Conflict Resolution
If a clinician edits a section overlapping AI-scribed or patient-provided content → clinician wins. Log a `conflict_flagged` event on the entry.

### PHI Redaction — Central Gateway
Every LLM input must pass through a single `redactPHI()` function. Redacts: Name, IC/ID, Phone. Never log raw note content, AI prompts, patient name, phone, or IC/ID.

### Self-Learning (Bonus — simplified)
```
importance_score = highlight_count × 1.0
                 + recency_bonus
                 + risk_level_tag
```
State honestly in the brief: this is a simplified 3-factor rule, not a full learned model.

### Glance View
`OPEN ACTIONS` is not a separate system — it's just a view of unresolved Comments/assignments. P95 latency target for glance view: ≤ 300ms.

## API Endpoints

```
GET  /patients
GET  /patients/:id
GET  /patients/:id/timeline
POST /timeline
PUT  /timeline/:id
GET  /timeline/:id/changes?since=<timestamp>
```

## Required Test Files

| File | What it tests |
|---|---|
| `test_rbac_scope.py` | Role permissions, multi-clinic isolation (incl. Admin cross-clinic → 403), section-level write |
| `test_revision_history.py` | Version increments, revert restores state, audit log metadata |
| `test_highlight_provenance.py` | `provenance_pointer` resolves; `quoted_text` locates source span |
| `test_concurrent_edits.py` | Doctor edits PLAN, Nurse edits STAFF_NOTE concurrently, no overwrite (verified via `section_key`) |
| `test_self_learning_importance.py` | Conceptual — assert weight/recency/risk affect ordering |

## Deliberate Trade-offs (document in README and brief)

- **Self-Learning**: Simplified 3-factor version, not the full 5-factor formula
- **Provenance**: `quoted_text` text-match, not offset-tracking
- **Concurrency**: Single `section_key` field, not a separate concurrency table
- **Voice capture**: Not implemented — explicitly dropped

## What to Include in README

Overview / Architecture / Tech Stack / Setup & Run / DB Schema / RBAC / Inline Collaboration / Provenance / Versioning / PHI Redaction / Conflict Resolution / Encryption / Logging Policy / Self-Learning / Latency / Testing / Assumptions / Trade-offs & Known Limitations

## Language Policy
- All deliverables must be in English: code, comments, commit messages, variable
  and database field names, README.md, the technical brief, ATTRIBUTION.txt,
  and any generated documentation.
- Conversational replies to me in this chat can be in Traditional Chinese or
  English, whichever I use in that message — but every file you write or
  edit must stay in English regardless of the conversation language.
- If unsure whether something counts as a "deliverable," default to English.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
