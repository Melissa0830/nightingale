/**
 * Deterministic Core risk floor for Glance Highlights — NOT Self-Learning.
 *
 * Pure, synchronous, side-effect free: no Prisma, no DB, no network, no env
 * vars, no LLM. Inspects ONLY the two fields passed in — Highlight.importance
 * and Highlight.feedback are never inputs, by design. A deterministic
 * critical floor must never be downgradable by future Self-Learning
 * weighting, exposure count, recency, or accept/reject feedback.
 *
 * Scope boundary: this classifies existing Highlight rows only. It does not
 * scan TimelineEntry.content for entries that have no associated Highlight —
 * there is no automatic Highlight-extraction pipeline in this prototype, so
 * a critical concern mentioned in a note but never captured as a Highlight
 * will not surface through this mechanism. See design review for the exact
 * Known Limitation wording.
 *
 * Trigger list is deliberately short and literal-substring (not regex, not
 * fuzzy, not an LLM) so it stays auditable:
 *   - "anaphylaxis"          — unambiguous life-threatening allergic
 *                              reaction; more specific than the generic
 *                              "allergy", which must NOT trigger alone.
 *   - "chest pain"           — matches the brief's own Glance View worked
 *                              example ("CRITICAL: Chest pain worsening");
 *                              specific two-word phrase, so generic "pain"
 *                              alone never matches.
 *   - "difficulty breathing" — specific respiratory-emergency phrase,
 *                              distinct from unrelated uses of "breathing".
 *   - "suicidal"             — unambiguous mental-health emergency term.
 * Each phrase was chosen to be specific enough that it cannot be confused
 * with a benign use of a related generic word.
 */
export type RiskFloor = "critical" | "unrated";

const CRITICAL_TRIGGERS: readonly string[] = [
  "anaphylaxis",
  "chest pain",
  "difficulty breathing",
  "suicidal",
];

export function classifyRiskFloor(input: {
  quotedText: string;
  riskReason: string;
}): RiskFloor {
  const haystack = `${input.quotedText} ${input.riskReason}`.toLowerCase();
  const isCritical = CRITICAL_TRIGGERS.some((trigger) => haystack.includes(trigger));
  return isCritical ? "critical" : "unrated";
}
