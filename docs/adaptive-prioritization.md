# Adaptive Highlight Prioritization

> Deterministic, clinic-scoped, safety-bounded, auditable.
> This document describes the **implemented** behaviour only.

Nightingale uses deterministic clinical and workflow signals to establish base
priority, while clinician accept/reject feedback provides a **separate**
adaptive adjustment for recurring highlight patterns. The adaptive layer does
not override deterministic safety floors.

Recurring patterns are matched using exact normalized text first, followed by a
deterministic lexical-overlap fallback when wording is not identical. This
lexical heuristic is auditable and does not infer semantic or clinical
equivalence.

Persisted feedback history and temporal (recency) weighting are intentionally
deferred because the current prototype does not contain a truthful longitudinal
feedback-event timestamp.

---

## 1. Layered model

```
Deterministic riskFloor            src/lib/risk/classify-risk.ts
        │   critical | unrated — non-negotiable safety boundary
        ▼
Base importance (Highlight.importance)     never overwritten
        +
Adaptive adjustment (feedback-derived, clamped ±2)
        ▼
effectiveImportance = baseImportance + learnedAdjustment   (derived, not persisted)
        ▼
Safety-first presentation order
```

- `riskFloor` is computed only from `quotedText` + `riskReason`. Adaptive logic
  never feeds it and never mutates it.
- `Highlight.importance` is treated as read-only `baseImportance`. Learned
  values are **never** written back.
- All adaptive fields are derived at read time in
  `GET /api/patients/:id/highlights`. Nothing adaptive is persisted.

## 2. Adaptive formula (`src/lib/highlights/derive-adaptive-priority.ts`)

```
reviewCount        = acceptedCount + rejectedCount        (pending never counts)
acceptanceRate     = acceptedCount / reviewCount          (null when reviewCount == 0)
learningStatus     = no_feedback        (reviewCount == 0)
                     gathering_feedback (0 < reviewCount < 3)
                     adaptive           (reviewCount >= 3)
learnedAdjustment  = 0                                     (reviewCount < 3)
                     clamp(acceptedCount - rejectedCount, -2, +2)   (otherwise)
effectiveImportance = baseImportance + learnedAdjustment
```

`effectiveImportance` is a derived prioritization value. `Highlight.importance`
has no defined legal range in the schema, so `effectiveImportance` is
deliberately **not** re-clamped to an invented range.

### Constants (fixed prototype heuristics — not clinically validated)

| Constant | Value | Meaning |
|---|---|---|
| `ADAPTIVE_FEEDBACK_THRESHOLD` | `3` | minimum non-pending clinician reviews before any adjustment |
| `ADAPTIVE_ADJUSTMENT_CLAMP` | `2` | hard bound on `learnedAdjustment` in either direction |
| `LEXICAL_MIN_SHARED_TOKENS` | `2` | minimum shared non-stop tokens for a lexical match |
| `LEXICAL_JACCARD_THRESHOLD` | `0.60` | minimum Jaccard score for a lexical match |

## 3. Recurring-pattern grouping

### 3a. Exact normalized match (first stage)

`normalizeRiskReason()`: lowercase → trim → collapse internal whitespace →
remove `. , ; : ! ?` → re-collapse whitespace. Word-internal characters
(hyphens, apostrophes, digits) are preserved. Two reasons whose normalized
strings are identical share a bucket (`matchMethod = "exact"`,
`lexicalOverlapScore = 1`).

### 3b. Deterministic lexical-overlap fallback (`src/lib/highlights/lexical-grouping.ts`)

Runs **only** when a risk reason has no exact bucket.

1. Tokenize the normalized reason: split on whitespace, drop empties, drop a
   small explicit generic stop-word set
   (`a an the and or of to in on at for` — English function words, not a
   clinical ontology, no synonyms).
2. For each existing same-clinic bucket, compute
   `jaccard = |A ∩ B| / |A ∪ B|` against the bucket representative's tokens.
3. A lexical match requires **both** `sharedTokenCount >= 2` **and**
   `jaccard >= 0.60`.
4. **Multi-bucket resolution:** highest Jaccard wins; on an exact score tie,
   the bucket whose representative Highlight id is lexicographically smallest
   wins. The result is independent of array/query/insertion order.

Result fields (derived, not persisted): `matchMethod` (`exact | lexical | none`),
`lexicalOverlapScore` (`1` | Jaccard | `null`), `matchedPattern`,
`matchedBucketRepresentativeId`.

#### Calibration (from `lexical-grouping.test.ts`, representative bucket = "Persistent symptoms may require follow-up.")

| Variation | shared tokens | Jaccard | result |
|---|---|---|---|
| insert one word ("respiratory") | 5 | 0.833 | lexical |
| reorder + drop period | 5 | 1.000 | lexical |
| drop one word | 4 | 0.800 | lexical |
| two shared tokens + noise | 2 | 0.182 | none |
| one shared token only | 1 | 0.125 | none |
| different domain | 0 | 0.000 | none |

The threshold sits in a wide gap between the match and non-match clusters; it is
a fixed engineering heuristic, not tuned against a single demo fixture.

### 3c. Bucket representative

Each same-clinic exact-normalized bucket has one deterministic representative:
the **earliest-created** Highlight in the bucket, with **Highlight id ASC** as
the final tie-break. Never left to database return order.

## 4. Clinic scoping

The feedback aggregation query filters
`where feedback in (accepted, rejected) AND patient.clinicId = <this patient's clinic>`
**before** any exact or lexical matching. Clinic A feedback can never influence
Clinic B and vice versa. `synthetic-patient-learning-b` (Clinic B) carries the
same normalized risk-reason wording as Clinic A's positive bucket but stays at
`learnedAdjustment = -2`, proving isolation live.

## 5. Safety-first presentation order (`src/lib/highlights/order-adaptive-highlights.ts`)

Comparator, applied to the non-Patient response (not persisted):

1. `riskFloor` severity — `critical` before `unrated`, **always**
2. `effectiveImportance` DESC
3. `createdAt` DESC
4. `id` ASC

A `critical` Highlight with `effectiveImportance = -2` still sorts before an
`unrated` Highlight with `effectiveImportance = +10`. Adaptive scoring can only
reorder within a `riskFloor` band.

## 6. The feedback loop

`Highlight.feedback` (persisted, `pending | accepted | rejected`) is the
authoritative current observation. `PATCH /api/highlights/:id` is
**Clinician-only** and writes only that field (no side effects: no AuditEvent,
no system_event, no TimelineEntry/Version/importance/riskFloor change).

After a Clinician Accept/Reject the Context Panel does **not** guess the new
score: it captures the current server-derived `effectiveImportance`, PATCHes,
then does a fresh `GET` and reads the new server-derived value, showing
`Adaptive priority recalculated: X → Y` or
`Feedback saved. Adaptive priority unchanged.` A denied PATCH produces no
recalculation state; a PATCH that succeeds but whose refresh fails shows a
"could not refresh" message and no fabricated score.

## 7. Role behaviour

| Role | Adaptive metadata | Accept / Reject | Pattern / feedback counts |
|---|---|---|---|
| Clinician | yes | yes | yes |
| Staff | read-only | no (403) | read-only |
| Admin | read-only | no (403) | read-only |
| Patient | **none** — server strips every adaptive/riskFloor field | no (403) | none |

Patient enforcement is server-side in the route (minimal highlight shape,
original order), not a UI conditional.

## 8. Feedback-history and recency gates (both deferred)

**Persisted feedback history — not implemented.** No existing schema structure
truthfully models an append-only highlight feedback-transition record
(`highlightId`, actor, `previousFeedback`, `newFeedback`, event timestamp).
`AuditEvent` models note revisions (its `action` enum has no highlight value and
it has no `highlightId`); `system_event` is a visible timeline row, not a
structured record; overloading either would be semantically wrong. A dedicated
append-only `HighlightFeedbackEvent` relation would require a schema migration,
which is out of scope here. **Persisted longitudinal feedback history would
require a dedicated append-only `HighlightFeedbackEvent` relation and is
therefore reserved as a production extension rather than being retrofitted into
an unrelated prototype table.**

**Recency weighting — not implemented.** `Highlight` has no `updatedAt`; `PATCH`
updates no timestamp; `Highlight.createdAt` is row-creation (seed) time, not
feedback-change time. The forbidden substitutes (`TimelineEntry.updatedAt/
createdAt`, `Highlight.createdAt`, seed reset time, GET-time `now`, Glance
`recentChanges`) would make the score less auditable, not more.
**Recency weighting is intentionally deferred because the prototype stores
current Highlight feedback state but not a longitudinal feedback-event
timestamp.** The v1 `learnedAdjustment` formula is unchanged.

## 9. Demo scenarios

Navigate: **Clinician → Patients → Synthetic Learning Patient** (Clinic A,
tagged "Adaptive prioritization demo") → open the target entry → Context Panel →
Highlights. No URL typing required.

| Entry | Bucket | Feedback | Target result |
|---|---|---|---|
| `synthetic-entry-learning-followup` | X — "persistent symptoms may require follow-up" | 3 accepted + pending target | **positive** `+2` |
| `synthetic-entry-learning-followup` | X (lexical) — "Persistent **respiratory** symptoms may require follow-up." | pending, ~0.83 overlap → bucket X | **lexical** `+2` |
| `synthetic-entry-learning-medreview` | Y — "medication review advised at next visit" | 2 accepted + pending target | **gathering feedback** `0` |
| `synthetic-entry-learning-riskflag` | Z — "imaging finding likely incidental; no action needed" | 3 rejected + pending target | **negative** `-2` |
| `synthetic-patient-learning-b` (Clinic B) | X wording, 3 rejected | pending target | **isolated** `-2` (unaffected by Clinic A) |

Seed fixtures use fixed ids and idempotent upserts; the learning entry ids are
in the seed's exact reset list. Patient A's highlight inventory is untouched.

## 10. Truth boundaries

- Adaptive priority is **not** a clinical probability.
- Acceptance rate is **not** AI confidence, accuracy, or diagnostic confidence.
- Clinician accept/reject feedback does **not** establish medical truth,
  diagnosis, or clinical correctness.
- Lexical overlap does **not** establish semantic or clinical equivalence, and
  does **not** infer synonyms — two clinically similar concerns with different
  vocabulary may remain in separate buckets. This is intentional; it preserves
  deterministic auditability.
- `riskFloor` remains deterministic and authoritative; adaptive logic can never
  downgrade `critical`, suppress a `critical` Highlight, or move an item across
  the safety boundary.
- Learning is **clinic-scoped**; there is no cross-clinic learning.
- All demo learning data are synthetic.
- All thresholds/constants are fixed prototype heuristics.
- No embeddings, no vector database, no model retraining, no LLM-based grouping,
  no predictive-performance claim.
- Persisted feedback history: **not implemented** (see §8).
- Recency weighting: **not implemented** (see §8).

## 11. Test coverage

| File | Scope |
|---|---|
| `src/lib/risk/classify-risk.test.ts` | riskFloor determinism (unchanged) |
| `src/lib/highlights/derive-adaptive-priority.test.ts` | threshold, clamp, sign, reviewCount, acceptanceRate, learningStatus, base-importance preservation, riskFloor independence, normalization |
| `src/lib/highlights/order-adaptive-highlights.test.ts` | safety-first comparator, tie-breaks, determinism |
| `src/lib/highlights/lexical-grouping.test.ts` | exact/lexical/none, both gates, ambiguous multi-bucket, exact-score tie determinism, order independence, printed calibration table |
| `test_adaptive_highlight_priority.py` | live: same-clinic aggregation, pending excluded, cross-clinic isolation, Patient-role field stripping, server-confirmed recompute (PATCH-reversible), exact vs lexical vs none |
