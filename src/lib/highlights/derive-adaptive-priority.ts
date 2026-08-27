/**
 * Feedback-Informed Adaptive Highlight Prioritization — pure derivation.
 *
 * Bonus feature. Deterministic, side-effect free: no Prisma, no DB, no
 * network, no LLM, no embeddings, no fuzzy/semantic matching.
 *
 * What this computes: a ranking-only adjustment derived from how clinicians
 * in the SAME clinic have accepted/rejected other Highlights that share the
 * SAME recurring normalized risk-reason pattern.
 *
 * What this MUST NOT do (enforced by keeping it out of this module):
 *   - it never sees or returns riskFloor — the deterministic safety floor
 *     (src/lib/risk/classify-risk.ts) is authoritative and independent;
 *   - it never mutates Highlight.importance — that value is treated as
 *     baseImportance and passed in read-only;
 *   - a single clinician action cannot move the number: below a fixed
 *     non-pending threshold the adjustment is exactly 0.
 *
 * "Recurring normalized risk-reason pattern" = deterministic exact-string
 * match after normalization. It is explicitly NOT a claim of semantic or
 * clinical similarity.
 */

/** Non-pending feedback observations required before any adjustment applies. */
export const ADAPTIVE_FEEDBACK_THRESHOLD = 3;

/** Hard bound on the adjustment in either direction. */
export const ADAPTIVE_ADJUSTMENT_CLAMP = 2;

/**
 * Deterministic normalization for risk-reason bucket identity.
 *
 * Steps (all deterministic, no dictionaries, no stemming):
 *   - lowercase
 *   - trim leading/trailing whitespace
 *   - collapse internal whitespace runs to a single space
 *   - remove simple sentence punctuation: . , ; : ! ?
 *   - re-collapse whitespace produced by the previous step
 *
 * Word-internal characters (hyphens, apostrophes, digits) are preserved.
 */
export function normalizeRiskReason(riskReason: string): string {
  return riskReason
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface AdaptivePriorityInput {
  /** Highlight.importance, read-only. Never written back. */
  baseImportance: number;
  /** Count of `accepted` Highlights in the same clinic + normalized bucket. */
  acceptedCount: number;
  /** Count of `rejected` Highlights in the same clinic + normalized bucket. */
  rejectedCount: number;
}

/**
 * Descriptive learning state for a Highlight's recurring pattern. Purely a
 * function of how many non-pending clinician reviews the pattern has:
 *   - `no_feedback`        — 0 reviews
 *   - `gathering_feedback` — 1..(threshold-1) reviews, no adjustment yet
 *   - `adaptive`           — >= threshold reviews, adjustment applies
 */
export type LearningStatus = "no_feedback" | "gathering_feedback" | "adaptive";

export interface AdaptivePriority {
  acceptedCount: number;
  rejectedCount: number;
  /** acceptedCount + rejectedCount. `pending` never contributes. */
  feedbackCount: number;
  /** Alias of feedbackCount — the number of non-pending clinician reviews. */
  reviewCount: number;
  /**
   * acceptedCount / reviewCount, or `null` when reviewCount === 0.
   * Descriptive only — this is an acceptance rate, NOT a confidence,
   * accuracy, or clinical-probability measure.
   */
  acceptanceRate: number | null;
  learningStatus: LearningStatus;
  /**
   * 0 while feedbackCount < ADAPTIVE_FEEDBACK_THRESHOLD; otherwise
   * clamp(acceptedCount - rejectedCount, -CLAMP, +CLAMP).
   */
  learnedAdjustment: number;
  /**
   * baseImportance + learnedAdjustment. A derived prioritization value —
   * Highlight.importance has no defined legal range in the schema, so this
   * is intentionally not re-clamped to an invented range.
   */
  effectiveImportance: number;
}

export function deriveAdaptivePriority(
  input: AdaptivePriorityInput,
): AdaptivePriority {
  const { baseImportance, acceptedCount, rejectedCount } = input;
  const feedbackCount = acceptedCount + rejectedCount;

  const learnedAdjustment =
    feedbackCount < ADAPTIVE_FEEDBACK_THRESHOLD
      ? 0
      : clamp(
          acceptedCount - rejectedCount,
          -ADAPTIVE_ADJUSTMENT_CLAMP,
          ADAPTIVE_ADJUSTMENT_CLAMP,
        );

  const learningStatus: LearningStatus =
    feedbackCount === 0
      ? "no_feedback"
      : feedbackCount < ADAPTIVE_FEEDBACK_THRESHOLD
        ? "gathering_feedback"
        : "adaptive";

  return {
    acceptedCount,
    rejectedCount,
    feedbackCount,
    reviewCount: feedbackCount,
    acceptanceRate: feedbackCount === 0 ? null : acceptedCount / feedbackCount,
    learningStatus,
    learnedAdjustment,
    effectiveImportance: baseImportance + learnedAdjustment,
  };
}
