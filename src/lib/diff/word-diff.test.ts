/**
 * Focused pure tests for the word-level version diff helper.
 *
 * Convention matches src/lib/risk/classify-risk.test.ts: Node's built-in
 * assert only, plain PASS/FAIL print + exit code.
 *
 * Run: npx tsx src/lib/diff/word-diff.test.ts
 */
import assert from "node:assert/strict";
import { buildWordDiff, hasContentChanges, type DiffPart } from "./word-diff";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`[FAIL] ${name}`);
    console.log(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Reconstructing each side from the parts must reproduce the inputs exactly:
// "same" + "removed" == oldText, "same" + "added" == newText. This single
// invariant is the strongest correctness check for a diff.
function oldSide(parts: DiffPart[]): string {
  return parts.filter((p) => p.kind !== "added").map((p) => p.value).join("");
}
function newSide(parts: DiffPart[]): string {
  return parts.filter((p) => p.kind !== "removed").map((p) => p.value).join("");
}

check("identical content -> no added/removed parts", () => {
  const parts = buildWordDiff("Continue monitoring and review in four weeks.", "Continue monitoring and review in four weeks.");
  assert.equal(hasContentChanges(parts), false);
  assert.ok(parts.every((p) => p.kind === "same"));
});

check("both empty -> no parts, no changes", () => {
  const parts = buildWordDiff("", "");
  assert.deepEqual(parts, []);
  assert.equal(hasContentChanges(parts), false);
});

check("one-word addition", () => {
  const parts = buildWordDiff("Review in weeks.", "Review in four weeks.");
  assert.equal(hasContentChanges(parts), true);
  assert.deepEqual(parts.filter((p) => p.kind === "added").map((p) => p.value), ["four "]);
  assert.equal(parts.filter((p) => p.kind === "removed").length, 0);
  assert.equal(oldSide(parts), "Review in weeks.");
  assert.equal(newSide(parts), "Review in four weeks.");
});

check("one-word removal", () => {
  const parts = buildWordDiff("Review in four weeks.", "Review in weeks.");
  assert.equal(hasContentChanges(parts), true);
  assert.deepEqual(parts.filter((p) => p.kind === "removed").map((p) => p.value), ["four "]);
  assert.equal(parts.filter((p) => p.kind === "added").length, 0);
  assert.equal(oldSide(parts), "Review in four weeks.");
  assert.equal(newSide(parts), "Review in weeks.");
});

check("word replacement -> one removed + one added, order preserved", () => {
  const parts = buildWordDiff("Follow up in two weeks.", "Follow up in four weeks.");
  assert.equal(hasContentChanges(parts), true);
  assert.deepEqual(parts.filter((p) => p.kind === "removed").map((p) => p.value), ["two"]);
  assert.deepEqual(parts.filter((p) => p.kind === "added").map((p) => p.value), ["four"]);
  assert.equal(oldSide(parts), "Follow up in two weeks.");
  assert.equal(newSide(parts), "Follow up in four weeks.");
});

check("punctuation change is detected", () => {
  const parts = buildWordDiff("BP stable, no concerns", "BP stable; no concerns");
  assert.equal(hasContentChanges(parts), true);
  assert.equal(oldSide(parts), "BP stable, no concerns");
  assert.equal(newSide(parts), "BP stable; no concerns");
});

check("multi-sentence text: only the changed sentence differs", () => {
  const oldText = "Vitals reviewed and normal. Patient comfortable at rest. Follow-up confirmed.";
  const newText = "Vitals reviewed and normal. Patient reports mild fatigue at rest. Follow-up confirmed.";
  const parts = buildWordDiff(oldText, newText);
  assert.equal(hasContentChanges(parts), true);
  assert.equal(oldSide(parts), oldText);
  assert.equal(newSide(parts), newText);
  // The unchanged opening and closing sentences survive as "same" runs.
  const sameText = parts.filter((p) => p.kind === "same").map((p) => p.value).join("");
  assert.ok(sameText.includes("Vitals reviewed and normal."));
  assert.ok(sameText.includes("Follow-up confirmed."));
});

check("whitespace (incl. newlines) is preserved verbatim in reconstruction", () => {
  const oldText = "Line one.\nLine two.";
  const newText = "Line one.\nLine two changed.";
  const parts = buildWordDiff(oldText, newText);
  assert.equal(oldSide(parts), oldText);
  assert.equal(newSide(parts), newText);
  assert.ok(parts.some((p) => p.kind === "same" && p.value.includes("\n")));
});

check("empty old -> everything added", () => {
  const parts = buildWordDiff("", "Brand new clinical note.");
  assert.equal(hasContentChanges(parts), true);
  assert.ok(parts.length > 0 && parts.every((p) => p.kind === "added"));
  assert.equal(newSide(parts), "Brand new clinical note.");
  assert.equal(oldSide(parts), "");
});

check("empty new -> everything removed", () => {
  const parts = buildWordDiff("Old clinical note to clear.", "");
  assert.equal(hasContentChanges(parts), true);
  assert.ok(parts.length > 0 && parts.every((p) => p.kind === "removed"));
  assert.equal(oldSide(parts), "Old clinical note to clear.");
  assert.equal(newSide(parts), "");
});

check("pure: inputs unchanged and output is deterministic", () => {
  const oldText = "Plan: monitor and review.";
  const newText = "Plan: monitor closely and review.";
  const a = JSON.stringify(buildWordDiff(oldText, newText));
  const b = JSON.stringify(buildWordDiff(oldText, newText));
  assert.equal(a, b);
  assert.equal(oldText, "Plan: monitor and review.");
  assert.equal(newText, "Plan: monitor closely and review.");
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
