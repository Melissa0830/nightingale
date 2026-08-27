/**
 * Deterministic safety-first presentation order for Highlights.
 *
 * Pure comparator, no Prisma / DB / network / LLM. Ordering is NEVER
 * persisted — it is a read-time presentation concern only.
 *
 * The comparator is safety-first by construction: the deterministic
 * riskFloor is the primary key, so a `critical` Highlight always sorts
 * before every `unrated` Highlight regardless of adaptive score. Adaptive
 * scoring can reorder Highlights only WITHIN the same riskFloor band — it
 * can never move an item across the safety boundary, and it never mutates
 * riskFloor (this module does not even import the classifier; it consumes
 * an already-computed riskFloor value).
 */
import type { RiskFloor } from "@/lib/risk/classify-risk";

// Lower rank sorts first. `critical` before `unrated`, always.
const RISK_FLOOR_RANK: Readonly<Record<RiskFloor, number>> = {
  critical: 0,
  unrated: 1,
};

export interface OrderableHighlight {
  riskFloor: RiskFloor;
  effectiveImportance: number;
  createdAt: string | Date;
  id: string;
}

/**
 * Comparator (returns < 0 if `a` should appear before `b`):
 *   1. riskFloor severity      — `critical` before `unrated` (non-negotiable)
 *   2. effectiveImportance DESC — within the same floor, higher first
 *   3. createdAt DESC          — newer first
 *   4. id ASC                  — final stable, fully deterministic tie-break
 */
export function compareHighlightPriority(
  a: OrderableHighlight,
  b: OrderableHighlight,
): number {
  const byFloor = RISK_FLOOR_RANK[a.riskFloor] - RISK_FLOOR_RANK[b.riskFloor];
  if (byFloor !== 0) return byFloor;

  if (a.effectiveImportance !== b.effectiveImportance) {
    return b.effectiveImportance - a.effectiveImportance;
  }

  const at = new Date(a.createdAt).getTime();
  const bt = new Date(b.createdAt).getTime();
  if (at !== bt) return bt - at;

  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Returns a new array sorted by {@link compareHighlightPriority}. Does not
 * mutate the input. Fully deterministic: identical input → identical output.
 */
export function orderHighlightsBySafetyThenPriority<T extends OrderableHighlight>(
  highlights: readonly T[],
): T[] {
  return [...highlights].sort(compareHighlightPriority);
}
