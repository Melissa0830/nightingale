/**
 * Deterministic lexical-overlap fallback for grouping recurring Highlight
 * risk-reason patterns (v2 Phase 11).
 *
 * Pure, local, side-effect free: no embeddings, no vector DB, no LLM, no
 * remote service, no synonym table, no stemming, no fuzzy library. It is a
 * literal-token Jaccard heuristic and is explicitly NOT semantic similarity
 * or clinical equivalence.
 *
 * Pipeline: exact normalized match first (see normalizeRiskReason); only if
 * there is no exact bucket does the lexical fallback run. A lexical match
 * requires BOTH a minimum count of shared meaningful tokens AND a minimum
 * Jaccard score — two conservative gates, not one.
 *
 * This module affects adaptive EVIDENCE GROUPING only. It never touches
 * riskFloor, quotedText, riskReason, provenance, feedback state, the source
 * TimelineEntry, patient visibility, or clinic authorization.
 */

/** Minimum number of shared non-stop tokens required for a lexical match. */
export const LEXICAL_MIN_SHARED_TOKENS = 2;

/** Minimum Jaccard score (|A ∩ B| / |A ∪ B|) required for a lexical match. */
export const LEXICAL_JACCARD_THRESHOLD = 0.6;

/**
 * Minimal, explicit generic English function-word list. NOT a clinical
 * ontology and NOT a synonym map — purely articles / conjunctions /
 * short prepositions that carry no distinguishing meaning between two
 * risk-reason phrases.
 */
export const LEXICAL_STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
]);

/**
 * Deterministic token set of an ALREADY-normalized risk reason:
 * split on whitespace, drop empties, drop the small stop-word set.
 */
export function tokenizeRiskReason(normalizedRiskReason: string): Set<string> {
  return new Set(
    normalizedRiskReason
      .split(" ")
      .filter((t) => t.length > 0 && !LEXICAL_STOP_WORDS.has(t)),
  );
}

export function sharedTokenCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

/** Jaccard similarity of two token sets. Empty-vs-empty is defined as 0. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = sharedTokenCount(a, b);
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export type MatchMethod = "exact" | "lexical" | "none";

export interface LexicalBucket {
  /** Exact normalized riskReason — the bucket key. */
  key: string;
  /**
   * Deterministic representative: the earliest-created Highlight in the
   * bucket, with Highlight id ASC as the final tie-break. Chosen by the
   * caller; never left to database return order.
   */
  representativeId: string;
  /** The representative Highlight's raw riskReason (for display). */
  representativeRiskReason: string;
  /** Token set of the representative's normalized riskReason. */
  tokenSet: Set<string>;
}

export interface BucketResolution {
  matchMethod: MatchMethod;
  /** 1 for exact, the Jaccard value for lexical, null for none. */
  lexicalOverlapScore: number | null;
  matchedKey: string | null;
  /** The matched bucket representative's raw riskReason. */
  matchedPattern: string | null;
  matchedBucketRepresentativeId: string | null;
}

const NO_MATCH: BucketResolution = {
  matchMethod: "none",
  lexicalOverlapScore: null,
  matchedKey: null,
  matchedPattern: null,
  matchedBucketRepresentativeId: null,
};

/**
 * Resolve which existing recurring-pattern bucket a risk reason belongs to.
 *
 * 1. Exact normalized match wins outright (no lexical fallback then).
 * 2. Otherwise, among buckets that pass BOTH gates
 *    (sharedTokenCount >= LEXICAL_MIN_SHARED_TOKENS and
 *     jaccard >= LEXICAL_JACCARD_THRESHOLD), pick the highest Jaccard.
 * 3. On an exact Jaccard tie, pick the bucket whose representative id is
 *    lexicographically smallest.
 *
 * Fully order-independent: the result does not depend on the order of the
 * `buckets` array.
 */
export function resolveRiskReasonBucket(
  normalizedRiskReason: string,
  buckets: readonly LexicalBucket[],
): BucketResolution {
  const exact = buckets.find((b) => b.key === normalizedRiskReason);
  if (exact) {
    return {
      matchMethod: "exact",
      lexicalOverlapScore: 1,
      matchedKey: exact.key,
      matchedPattern: exact.representativeRiskReason,
      matchedBucketRepresentativeId: exact.representativeId,
    };
  }

  const candidateTokens = tokenizeRiskReason(normalizedRiskReason);

  let best: { bucket: LexicalBucket; score: number } | null = null;
  for (const bucket of buckets) {
    if (sharedTokenCount(candidateTokens, bucket.tokenSet) < LEXICAL_MIN_SHARED_TOKENS) {
      continue;
    }
    const score = jaccard(candidateTokens, bucket.tokenSet);
    if (score < LEXICAL_JACCARD_THRESHOLD) continue;

    if (
      best === null ||
      score > best.score ||
      (score === best.score && bucket.representativeId < best.bucket.representativeId)
    ) {
      best = { bucket, score };
    }
  }

  if (best) {
    return {
      matchMethod: "lexical",
      lexicalOverlapScore: best.score,
      matchedKey: best.bucket.key,
      matchedPattern: best.bucket.representativeRiskReason,
      matchedBucketRepresentativeId: best.bucket.representativeId,
    };
  }

  return NO_MATCH;
}
