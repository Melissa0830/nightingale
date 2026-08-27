# Nightingale Performance Evidence

## Application Commit

`APPLICATION_FREEZE_CANDIDATE_HEAD = 7aa5129d13958dc27174c7da0c42c4187048925b`

This is the audited product/application code that was measured. No product-visible file (`src/**`,
`prisma/**`) changed after this commit — verified with `git log 7aa5129..HEAD -- src/ prisma/`
(empty).

## Documentation Commit Context

`CURRENT_DOCUMENTATION_HEAD` at the time of measurement =
`8b5065245614bf6fff7d156237c8c222ae73796d` (`docs: reconcile architecture browser evidence`).
Documentation commits do not change `APPLICATION_FREEZE_CANDIDATE_HEAD`.

## Measurement Date

2026-08-28, ~02:27–02:29 +08:00 (Asia/Singapore).

## Candidate Brief Requirement

From `docs/brief.pdf` (Technical Constraints and Architecture → Latency), faithful paraphrase:

- **Target surface:** loading the "consult glance view".
- **Threshold:** P95 ≤ 300 ms.
- **Qualifier:** on a **warm path**.
- **Obligation:** state how the measurement was performed / approximated in the Technical Brief.

## Measurement Target

**PRIMARY:** authenticated real HTTP request to `GET /api/patients/:id/glance` — the server endpoint
that backs the Glance view. This is **server endpoint warm-path response latency**, not full browser
render / React paint / user-perceived page latency.

`NOT MEASURED:` full browser render latency (see "Browser-performance boundary" below).

## Environment

| Item | Value |
|---|---|
| OS | macOS 26.5.1 (Darwin 25F80), arm64 |
| Runtime | Node v25.7.0, npm 11.10.1 |
| App mode | **Production** — `npm run build` then `npm run start` (`next start`), Next.js 16.3.3 |
| Port | 3200 (dedicated to this measurement; a separate dev server on 3100 was left untouched) |
| Database provider | PostgreSQL on Neon (serverless) |
| Database region | `ap-southeast-1` (Singapore) — from the `DATABASE_URL` host `…c-3.ap-southeast-1.aws.neon.tech` |
| App process location | Local developer machine (Singapore timezone); same region as the database |
| Target role | Clinician (Glance is an internal surface) |
| Target patient | `synthetic-patient-learning` (Clinic A) — the canonical full-workflow demo patient; the Glance-heaviest record (13 risk highlights, 5 recent-change rows) |
| Timestamp / timezone | 2026-08-28 ~02:27 +08:00 |

This is a **prototype / local production-mode** measurement. It is **not** a production-hosting
certification and does not model network egress from an external client.

## Authentication Setup

- Token obtained via the real login path: `POST /api/auth/login` with
  `{ "email": "clinician.a@clinic-a.test" }` → `{ token }` (HS256 JWT).
- Auth is **setup only** and is **excluded** from every timed Glance sample. Login performs a single
  `prisma.user.findUnique` read and signs a token; it creates no persisted state.
- No auth bypass, no direct route-function calls — every sample is a real HTTP request to the running
  production app.

## Canonical Synthetic Data

- Reseeded to the canonical baseline immediately before measuring: `npx tsx prisma/seed.ts`
  ("Synthetic seed complete (idempotent upsert, baseline reset).").
- Canonical baseline verified after measurement: 2 clinics, 5 users, 4 patients, 15 timeline
  entries, 19 highlights, 2 comments, 0 versions, 0 audit events, 0 AI-scribed notes, 0
  `system_event` rows, 0 non-`synthetic-` entries, 0 non-`synthetic-` comments.
- Dataset size was **not** altered to influence latency.
- One pre-existing stray non-synthetic comment (`id cmtbrzv38001fabcdda0k7jer`, content `"ddykf"`,
  `resolved: true`, `createdAt 2026-08-27T17:07:28Z`) — debris from the user's earlier manual
  browser QA, predating this session — survived the idempotent reseed and was removed after
  measurement to restore canonical. It was `resolved: true`, so it never appeared in `openActions`
  (`resolved: false` filter) and had **no** effect on the measured Glance payload or latency.

## Recent Changes Preview Cross-Check

**CONFIRMED — preview uses already-returned content; no extra request/query.**

- `GET /api/patients/:id/glance` `recentChanges` branch already selects `content: true`
  (`src/app/api/patients/[id]/glance/route.ts`, alongside `id`, `type`, `sectionKey`, `updatedAt`;
  `orderBy updatedAt desc`, `take: 5`, `type != system_event`).
- `src/components/Glance.tsx` issues exactly **one** `fetch` — `/api/patients/:id/glance` in a single
  `useEffect`.
- `previewContent(content)` (`Glance.tsx`) is a pure, deterministic string transform
  (`replace(/\s+/g," ")`, `trim`, `slice`) applied to the already-returned `content` inside
  `recentChanges.map(...)`. It triggers **no** per-row API request, **no** per-row database lookup,
  and introduces **no** N+1 route/query path.

## Glance Query Shape

- `src/app/api/patients/[id]/glance/route.ts`: after one sequential `patient.findUnique` for
  auth/clinic scope, the route runs **three Prisma read branches executed in parallel** via
  `Promise.all([...])`:
  1. `comment.findMany` — `resolved: false`, `timelineEntry.patientId = :id`, `orderBy createdAt asc`
     → Open Actions.
  2. `highlight.findMany` — `patientId = :id`, `orderBy createdAt desc` → risk floor + adaptive
     derivation → Critical Risks.
  3. `timelineEntry.findMany` — `patientId = :id`, `type != system_event`, `orderBy updatedAt desc`,
     `take: 5` → Recent Changes.
- Glance is **derived at request time**; there is no Glance table/model and nothing is persisted by
  this endpoint.
- (SQL-statement count at the driver level was not independently traced; wording is deliberately
  "three Prisma read branches executed in parallel", not "exactly three SQL statements".)

## Warm-Up

- **10** successful `GET /api/patients/:id/glance` requests were issued and discarded before timing.
- Excluded from warm samples: application startup, `next build` output, Next.js route
  first-compilation, Prisma client initialization, and cold database-connection establishment.
- Warm-up validity: 10/10 returned HTTP 200 with a well-formed Glance body.

## Measurement Method

- Temporary local Python 3 script using `time.perf_counter()` around a single
  `urllib.request.urlopen` call per sample against the running production HTTP app
  (`http://localhost:3200`). No dependency added; no route function called directly. The script was
  kept in the scratchpad (outside the repository) and removed after the run — it is not committed.
- **Sample count:** 40 warm samples (target ≥ 20; 40 collected and all retained — no cherry-picking).
- **Per-sample validation:** a sample counts only if HTTP status is 200 **and** the body parses as
  JSON **and** contains `openActions`, `riskHighlights`, and `recentChanges`. Any 4xx/5xx/invalid
  JSON/connection error is recorded as a failure, not a fast sample.
- **Percentile method:** nearest-rank, `rank = ceil(p × N)`, value = `sorted_ascending[rank − 1]`.
  For N = 40: p50 → rank 20; p95 → rank 38.

## Raw Samples

| Sample | HTTP Status | Latency ms |
|---|---|---|
| 1 | 200 | 19.35 |
| 2 | 200 | 28.66 |
| 3 | 200 | 146.21 |
| 4 | 200 | 23.20 |
| 5 | 200 | 34.36 |
| 6 | 200 | 34.23 |
| 7 | 200 | 24.34 |
| 8 | 200 | 29.71 |
| 9 | 200 | 24.97 |
| 10 | 200 | 21.98 |
| 11 | 200 | 23.97 |
| 12 | 200 | 25.49 |
| 13 | 200 | 24.18 |
| 14 | 200 | 23.01 |
| 15 | 200 | 26.85 |
| 16 | 200 | 25.88 |
| 17 | 200 | 21.13 |
| 18 | 200 | 27.05 |
| 19 | 200 | 31.93 |
| 20 | 200 | 21.03 |
| 21 | 200 | 17.74 |
| 22 | 200 | 18.91 |
| 23 | 200 | 17.27 |
| 24 | 200 | 17.27 |
| 25 | 200 | 15.92 |
| 26 | 200 | 18.38 |
| 27 | 200 | 16.18 |
| 28 | 200 | 25.02 |
| 29 | 200 | 24.79 |
| 30 | 200 | 17.34 |
| 31 | 200 | 17.83 |
| 32 | 200 | 17.91 |
| 33 | 200 | 19.18 |
| 34 | 200 | 33.36 |
| 35 | 200 | 17.71 |
| 36 | 200 | 20.45 |
| 37 | 200 | 18.00 |
| 38 | 200 | 23.29 |
| 39 | 200 | 21.35 |
| 40 | 200 | 29.43 |

Failures during sampling: **none** (40/40 valid HTTP 200).

## Results

| Metric | Value |
|---|---|
| N | 40 |
| min | 15.92 ms |
| p50 (median) | 23.01 ms |
| mean | 26.12 ms |
| **p95** | **34.23 ms** |
| max | 146.21 ms |

Percentile method: nearest-rank, `rank = ceil(0.95 × 40) = 38` → 34.23 ms.
The single 146.21 ms observation (sample 3) is a retained warm-path sample (not discarded); it does
not affect the p95.

### Optional secondary — COMPOSITE HTTP READ LATENCY

Three authenticated reads issued **sequentially** per iteration:
`GET /api/patients/:id` → `GET /api/patients/:id/timeline` → `GET /api/patients/:id/glance`.
10 warm-up iterations discarded; N = 30 timed; same method.

| Metric | Value |
|---|---|
| N | 30 |
| min | 56.25 ms |
| p50 | 64.18 ms |
| mean | 66.50 ms |
| p95 | 80.15 ms |
| max | 84.43 ms |

This is **composite HTTP read latency**, not browser-render latency, and does not replace the
primary Glance P95.

## Requirement Result

**PASS — warm-path Glance P95 = 34.23 ms ≤ 300.0 ms.**

## Evidence Boundary

- This is **server endpoint response latency** for `GET /api/patients/:id/glance`.
- **Warm path:** 10 discarded warm-up requests; startup / compilation / Prisma init / cold DB
  connection excluded.
- **Authenticated request:** real HS256 Bearer token from `POST /api/auth/login`; token acquisition
  excluded from samples.
- It is **not** full browser-render / React-paint / user-perceived page latency.
- It is a **prototype, local production-mode** measurement (app and Neon database both in
  `ap-southeast-1`); it is **not** a production-hosting certification and does not model external
  client network egress.
- Read-only: login + Glance/GET reads only; verified no `TimelineEntry` / `Comment` / `Highlight`
  feedback / `Version` / `AuditEvent` mutation resulted from sampling.

## Reusable README / Technical Brief Wording

> On application commit `7aa5129d13958dc27174c7da0c42c4187048925b`, the authenticated Glance endpoint
> (`GET /api/patients/:id/glance`, Clinician role, canonical synthetic dataset, production `next
> start` build, Neon PostgreSQL in `ap-southeast-1`) was measured over 40 warm HTTP requests after
> 10 discarded warm-up requests. Using the nearest-rank method (`rank = ceil(p × N)`), median
> latency was 23.01 ms and P95 was 34.23 ms, satisfying the Candidate Brief's ≤ 300 ms warm-path
> target. This measurement covers server endpoint response latency, not full browser rendering.
> Browser / render latency: NOT MEASURED.
