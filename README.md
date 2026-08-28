# Nightingale

Nightingale is a synthetic-data prototype of a collaborative, longitudinal patient
note clinic. It gives clinicians and staff one shared, role-aware record per
patient: a longitudinal Timeline of every note and session summary, a derived
clinician-facing Glance for rapid orientation, inline comments with mentions and
assignment, full version history with revert, quote-anchored provenance for
highlights, an AI Scribe ingestion path, and deterministic feedback-informed
prioritization of risk highlights.

The prototype uses synthetic demo records only and is not a production clinical
system. It performs no external LLM inference, makes no medical judgement, and
carries no compliance or deployment claim.

## Implemented Capabilities

| Capability | Final implemented scope |
|---|---|
| Longitudinal Timeline | Time-ordered per-patient record; server role-filters what each role may read |
| Glance | Derived at request time: Open Actions, Critical Risks, Recent Changes, Last Update — no Glance table |
| Collaboration | Flat entry-level comments with `mentions[]`, assignment, resolve/reopen; validated to same-clinic Staff/Clinician |
| Revision History | Full-content `Version` snapshots of replaced content; word-level diff in the UI |
| Optimistic Concurrency | `expectedVersion` required on every edit; a stale write returns HTTP 409 |
| Provenance | Same-entry quoted-text evidence for highlights; AI entries also store source-session metadata |
| AI Scribe | PHI-redacted ingestion into a deterministic local mock summarizer |
| Adaptive Highlights | Deterministic, feedback-informed priority adjustment, clamped and clinic-scoped |

## Roles & Access

Authorization is enforced server-side on every API route; client-side visibility
is not the security boundary. Each route verifies an HS256 bearer token and
re-derives `clinicId`, patient identity and section ownership from the database,
never from the request body. Cross-clinic requests are rejected for all roles,
including Admin.

| Role | Access |
|---|---|
| Patient | Own record only, read-only. Sees `patient_session_summary` entries only. No Glance, comments, highlights or Context surface. Internal single-entry reads return 404 to hide existence. |
| Staff | Internal clinical workspace; may edit `staff_note` sections; full comment/collaboration. |
| Clinician | May edit `plan` / `summary` / `medication` sections; comments; highlight Accept/Reject feedback; version history and revert. |
| Admin | Clinic-scoped read access to patient data. No generic global admin CRUD. |

Section ownership is fixed by a mapping (`staff_note` → Staff; `plan` / `summary`
/ `medication` → Clinician) and fails closed: a null or unknown section cannot be
edited by anyone.

## Demo Records & Canonical Reset

All records are synthetic and defined in `prisma/seed.ts`.

| Record | Purpose |
|---|---|
| **Synthetic Learning Patient** (Clinic A) | Internal full-workflow demo: Glance, collaboration, provenance, version/revert and adaptive-highlight examples. Has **no** Patient-login identity. |
| **Synthetic Patient A** (Clinic A) | Standard synthetic baseline; used for the Patient-role read-only view (`patient.a@clinic-a.test`). |
| Synthetic Patient B / Synthetic Learning Patient B (Clinic B) | Cross-clinic isolation baselines. |

Demo user accounts (passwordless — sign-in takes an email only):

| Email | Role |
|---|---|
| `clinician.a@clinic-a.test` | Clinician, Clinic A |
| `staff.a@clinic-a.test` | Staff, Clinic A |
| `patient.a@clinic-a.test` | Patient, Clinic A (linked to Synthetic Patient A) |
| `admin.a@clinic-a.test` | Admin, Clinic A |

**Canonical reset.** Initial seeding and later demo reset are the *same* command
(`npx tsx prisma/seed.ts`; see [Quick Start](#quick-start)) run at two different
moments, not two separate steps. Re-running it restores the canonical synthetic
fixtures by idempotent upsert and clears the `Version` / `AuditEvent` rows tests
generate for those fixtures. It does not delete unrelated rows created outside
the fixture set.

## Quick Start

### Prerequisites

- Node.js 20+ and npm.
- A PostgreSQL database. The reference environment uses Neon (serverless
  PostgreSQL); any PostgreSQL instance reachable via a connection URL works.

### Environment variables

Copy `.env.example` to `.env` and set:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string used by Prisma and the seed script. |
| `JWT_SECRET` | Secret for signing/verifying HS256 session tokens. |

Do not commit real secrets. (`.env.example` also lists `SYSTEM_SECRET`; it is not
read by the current code and can be left unset.)

### Install and run

```bash
npm install

# Apply the schema to the database and generate the Prisma client.
# There is no migration history in this repo; the schema is pushed directly.
npx prisma db push

# Load the canonical synthetic data. Re-run this same command any time to
# reset the demo after exploring.
npx tsx prisma/seed.ts

# Then run EITHER the dev server:
npm run dev
# OR a production-like build and start:
npm run build && npm run start
```

The app serves on `http://localhost:3000`.

## Architecture

Next.js (App Router) serves both the UI and the JSON API under `src/app/api/**`.
Prisma 7 with `@prisma/adapter-pg` talks to PostgreSQL (Neon hosted PostgreSQL in
the reference environment). Every API route authenticates an HS256 bearer token
and re-derives authorization from database values. The Glance view and adaptive
highlight ranking are computed at request time and never persisted. AI Scribe
summarization uses a local `MockLlmAdapter`; no external service is called.

Full diagrams and evidence:

- [`docs/architecture-system.md`](docs/architecture-system.md) — system / data-flow diagram.
- [`docs/architecture-schema.md`](docs/architecture-schema.md) — data schema and relationships.

Architecture facts in those documents are verified against the schema, routes and
authorization code at the recorded application commit. The final interaction
paths were verified manually in a browser by the author; there is no automated
end-to-end browser evidence, and none is claimed. A final demo rehearsal
reconfirms the interaction paths before recording.

## Technical Guarantees

| Behavior | Final rule |
|---|---|
| Clinic scope | Authorization derived from DB `clinicId` / patient identity; request body identifiers are never trusted. |
| Patient visibility | `patient_session_summary` entries only; everything else is filtered server-side (403 before DB access, or 404 to hide existence). |
| Section ownership | `staff_note` → Staff; `plan` / `summary` / `medication` → Clinician; `null` / unknown → deny for every role. |
| Edit concurrency | `PUT /api/timeline/:id` requires `expectedVersion`. |
| Stale conflict | Conditional update matches 0 rows → rollback, HTTP 409 `Conflict: entry has been modified`, **no `Version` row**, content unchanged. |
| Successful edit | Replaced content archived as a `Version`; `TimelineEntry.versionNumber` increments; `note_updated` audit. |
| Clinician override | Editing AI- or patient-authored content also writes a `conflict_flagged` audit and a visible `system_event`. |
| Revert | `POST /api/timeline/:id/revert` archives current content, sets the chosen historical content, advances `versionNumber` **forward** (never rewound); `note_reverted` audit + `system_event`. |
| Audit | `AuditEvent` is metadata only — actor, role, clinic, target ids, action, timestamp. No note content, prompt text or redacted text. |
| Glance | Derived per request from unresolved comments, highlight risk-floor classification, and recent entries. Not stored. |
| Glance counts | Recent Changes query uses `take: 5`; the UI shows 3. Open Actions UI shows 4 (with a "+N more" note). |

## AI Scribe

`POST /api/patients/:id/ai-scribe` (Staff or Clinician only). Supported session
types: `doctor_consult`, `nurse_consult`, `patient_session`.

```
session text
  → authenticate + clinic-scope check
  → redactPHI(rawText, knownNames)         # runs BEFORE the adapter
  → MockLlmAdapter.summarize(redactedText) # deterministic, local, no network
  → transaction: TimelineEntry (authorRole = system) + AiScribedNote + AuditEvent
```

- The raw transcript is redacted before it reaches the adapter and is never
  persisted or logged. `redactPHI()` masks known clinic names and
  Singapore-oriented NRIC/FIN and phone patterns.
- `MockLlmAdapter` returns a deterministic function of its input. It is not a
  trained model and performs no semantic or clinical reasoning.
- **No external LLM API is called by the submitted application.**
- The persisted `provenanceType` / `provenanceId` identify the source session.
  They are an origin link, not a claim of factual or clinical correctness.

## Adaptive Highlight Prioritization

A bonus feature. Priority is **deterministic and feedback-informed, not
model-trained** — no embeddings, semantic similarity, ML training, recency
learning or clinical-entity extraction.

Clinician Accept/Reject feedback (`PATCH /api/highlights/:id`) sets each
highlight's `feedback` to `pending` / `accepted` / `rejected`. At read time,
`GET /api/patients/:id/highlights` groups highlights in the **same clinic** by
normalized `riskReason` (exact normalized string match first; a deterministic
lexical-overlap fallback second — shared-token count ≥ 2 and Jaccard ≥ 0.60).
Within a bucket:

- `reviewCount` = accepted + rejected (`pending` never counts).
- With fewer than **3** reviews, `learnedAdjustment` is exactly `0`.
- Otherwise `learnedAdjustment = clamp(accepted − rejected, −2, +2)`.
- `effectiveImportance = baseImportance + learnedAdjustment` (base is
  `Highlight.importance`, `0` for all seeded rows).

Final ordering is **safety floor → effective priority → createdAt → id**.

**Critical risk floor (separate and authoritative).** `classifyRiskFloor()`
does a literal, case-insensitive substring check for exactly four trigger
phrases:

```
anaphylaxis   ·   chest pain   ·   difficulty breathing   ·   suicidal
```

A highlight matching any trigger is `critical` and sorts ahead of every
non-critical highlight regardless of feedback. This trigger-based floor is
deterministic, independent of adaptive feedback, and **is not a comprehensive
clinical risk assessment**.

## Performance

Measured on application commit `7aa5129d13958dc27174c7da0c42c4187048925b`.

| Item | Value |
|---|---|
| Target | `GET /api/patients/:id/glance` (authenticated) |
| Mode | Production `next start` (`npm run build` + `npm run start`), Next.js 16.3.3 |
| Role / dataset | Clinician, canonical synthetic dataset |
| Warm-up | 10 discarded requests |
| Measured | 40 warm requests |
| P50 | 23.01 ms |
| **P95** | **34.23 ms** |
| Requirement | ≤ 300 ms warm-path |
| Result | **PASS** |
| Percentile method | nearest-rank (`rank = ceil(p × N)`) |

Full method and raw samples: [`docs/performance-evidence.md`](docs/performance-evidence.md).

This measures authenticated server endpoint response latency, not full browser
rendering or user-perceived page latency. Browser / render latency was not
measured.

## Testing & Verification

The prototype was validated with targeted automated regression tests,
route/security checks, repository-level evidence audits, and user-performed
manual browser verification. This was not test-driven development, and there is
no independent automated end-to-end browser suite.

Core micro-tests (Python):

- [`test_rbac_scope.py`](test_rbac_scope.py) — role permissions, multi-clinic isolation, section-level write.
- [`test_revision_history.py`](test_revision_history.py) — version increments, revert, audit metadata.
- [`test_highlight_provenance.py`](test_highlight_provenance.py) — provenance pointer resolves; `quotedText` locates the source span.
- [`test_concurrent_edits.py`](test_concurrent_edits.py) — concurrent edits to different sections do not overwrite; stale same-section write is rejected.

Nine further Python tests (AI Scribe ingestion, comment collaboration, conflict
override, glance refresh, provenance source, timeline chronology, version diff,
adaptive priority, learning-patient workflow) and co-located TypeScript unit
tests (`*.test.ts` under `src/lib/**`) cover the remaining behaviors. Adaptive
prioritization is covered by `test_adaptive_highlight_priority.py` and the
`src/lib/highlights/*.test.ts` units; there is no file named
`test_self_learning_importance.py`.

## Bonus / Architectural-Only Items

| Item | Status |
|---|---|
| Self-learning importance logic | Implemented as the deterministic feedback-informed adjustment described above (simplified 3-signal rule, not a learned model). |
| Hybrid storage / data decay | Addressed at the architectural-discussion level only. No data-decay or hybrid-storage implementation exists in the submitted codebase; see the Technical Brief. |
| Ambient / voice consult capture | Not implemented. |
| Structured clinical entity tagging (allergy, medication, chief complaint, …) | Not implemented. These are bonus/non-goal boundaries, not Glance gaps. |

## Known Limitations / Non-Goals

- Comments render as a flat entry-level list. `Comment.parentId` exists in the
  schema and API but threaded replies are not rendered.
- Mentions and assignment are stored only; there is no notification delivery.
- Highlight provenance is same-entry only. There is no `sourceEntryId` or
  cross-entry source graph.
- Quote matching is exact substring search against the entry's current content,
  not persisted text offsets.
- AI Scribe inference is mocked; there is no real summarization model.
- PHI redaction is heuristic and Singapore-oriented, not medical-grade NER.
- Adaptive prioritization is deterministic lexical logic, not semantic ML. There
  is no feedback-history store or recency-weighted learning.
- No Patient-triggered AI session.
- No structured Allergy / Medication / ChiefComplaint store.
- Demo authentication is passwordless; there is no password or per-request token
  revocation beyond the token claims themselves.
- No production compliance claim and no encryption-at-rest implementation claim.
- Voice capture, and data decay / hybrid storage beyond architectural
  discussion, are not implemented.
- `npm audit` reports pre-existing findings in the Prisma / devDependency chain;
  no dependency versions were changed during this submission cycle.

## Attribution

- **Runtime AI:** no external LLM API is invoked. AI Scribe summarization uses a
  deterministic local `MockLlmAdapter`.
- **Development:** built with a structured, prompt-driven workflow using the AI
  coding assistant Claude, with author-directed scope decisions, review and
  manual browser verification.
- **Demo data:** entirely synthetic; no real patient data or external clinical
  dataset.
- **Database stack:** PostgreSQL · Neon hosted PostgreSQL · Prisma ·
  `@prisma/adapter-pg` + `pg`.
- **Third-party software and licenses:** see [`ATTRIBUTION.txt`](ATTRIBUTION.txt).

## Short Demo Guide

1. Sign in as Clinician (`clinician.a@clinic-a.test`) and open the **Synthetic
   Learning Patient**.
2. Review the internal workflow: Glance → Timeline / Context → a collaboration,
   version/revert and adaptive-highlight example.
3. Sign in as Patient (`patient.a@clinic-a.test`) and review the reduced,
   read-only patient view.

Exact recording choreography (ordering, mutation sequence, reseed timing) is
finalized during the final demo rehearsal.

## Submission Artifacts

| Artifact | Purpose |
|---|---|
| [`docs/architecture-system.md`](docs/architecture-system.md) | System / data-flow diagram and evidence boundary. |
| [`docs/architecture-schema.md`](docs/architecture-schema.md) | Data schema and entity relationships. |
| [`docs/performance-evidence.md`](docs/performance-evidence.md) | Glance latency measurement method and raw samples. |
| [`ATTRIBUTION.txt`](ATTRIBUTION.txt) | Third-party software, licenses, runtime-AI boundary, AI-assisted development disclosure. |
| Technical Brief | Added in a later submission step. |
| Demo recording | Added in a later submission step. |
