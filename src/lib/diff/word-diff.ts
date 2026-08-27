import { diffWordsWithSpace } from "diff";

/**
 * One contiguous run of the comparison, already classified.
 * `same` runs include whitespace verbatim so the reconstructed text reads
 * naturally; `added`/`removed` runs are whole words (or punctuation).
 */
export type DiffPart = {
  value: string;
  kind: "same" | "added" | "removed";
};

/**
 * Word-level diff with a fixed direction: OLD snapshot → CURRENT content.
 *
 *   kind "added"   — present in `newText`, not in `oldText`
 *   kind "removed" — present in `oldText`, not in `newText`
 *   kind "same"    — unchanged (whitespace preserved)
 *
 * Pure: no I/O, inputs are never mutated. This is the whole diff engine —
 * the DB stores full content snapshots (see the Version model); comparison
 * is a UI-layer concern only, per the project's stated architecture.
 *
 * Uses the `diff` package's `diffWordsWithSpace`, which tokenises on word
 * boundaries and keeps whitespace as its own tokens (so a changed word
 * never drags the surrounding spaces into the highlight).
 */
export function buildWordDiff(oldText: string, newText: string): DiffPart[] {
  const changes = diffWordsWithSpace(oldText, newText);
  return changes.map((change) => ({
    value: change.value,
    kind: change.added ? "added" : change.removed ? "removed" : "same",
  }));
}

/**
 * True if the comparison contains at least one added or removed run.
 * When false, the two texts are identical and the UI shows an explicit
 * "No content differences." message instead of an empty box — this is the
 * normal state right after reverting to the version being compared.
 */
export function hasContentChanges(parts: DiffPart[]): boolean {
  return parts.some((part) => part.kind !== "same");
}
