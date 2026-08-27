/**
 * Focused pure tests for the exact-quote locator.
 *
 * Convention matches src/lib/risk/classify-risk.test.ts: Node's built-in
 * assert only, plain PASS/FAIL print + exit code.
 *
 * Run: npx tsx src/lib/provenance/locate-quote.test.ts
 */
import assert from "node:assert/strict";
import { locateQuote, countMatches } from "./locate-quote";

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

// The core invariant: segments concatenate back to the exact original.
function rebuilt(content: string, quote: string): string {
  return locateQuote(content, quote).map((s) => s.text).join("");
}

check("1. one exact match -> countMatches 1, reconstruction exact", () => {
  const content = "Persistent cough noted at visit one. Each was flagged for review.";
  const quote = "Persistent cough noted at visit one";
  const segs = locateQuote(content, quote);
  assert.equal(countMatches(segs), 1);
  assert.equal(rebuilt(content, quote), content);
  assert.deepEqual(
    segs.map((s) => [s.match, s.text]),
    [
      [true, "Persistent cough noted at visit one"],
      [false, ". Each was flagged for review."],
    ],
  );
});

check("2. no match -> single non-match segment, countMatches 0", () => {
  const content = "Vitals reviewed and within normal range.";
  const quote = "Chest pain on exertion noted this visit";
  const segs = locateQuote(content, quote);
  assert.deepEqual(segs, [{ text: content, match: false }]);
  assert.equal(countMatches(segs), 0);
  assert.equal(rebuilt(content, quote), content);
});

check("3. multiple exact matches -> countMatches N, non-overlapping, reconstruction exact", () => {
  const content = "review. review. review.";
  const quote = "review.";
  const segs = locateQuote(content, quote);
  assert.equal(countMatches(segs), 3);
  assert.equal(rebuilt(content, quote), content);
  assert.equal(segs.filter((s) => !s.match).every((s) => s.text === " " || s.text === ""), true);
});

check("4. case mismatch is NOT a match (case-sensitive, same as the API)", () => {
  const content = "Small nodule noted, stable.";
  const quote = "small nodule noted, stable.";
  const segs = locateQuote(content, quote);
  assert.equal(countMatches(segs), 0);
  assert.deepEqual(segs, [{ text: content, match: false }]);
});

check("5. punctuation is significant", () => {
  const content = "BP stable; no concerns today.";
  assert.equal(countMatches(locateQuote(content, "BP stable, no concerns")), 0);
  assert.equal(countMatches(locateQuote(content, "BP stable; no concerns")), 1);
});

check("6. whitespace (incl. newlines) is preserved and significant", () => {
  const content = "Line one.\nPersistent fatigue noted at visit two.\nLine three.";
  const quote = "Persistent fatigue noted at visit two.";
  const segs = locateQuote(content, quote);
  assert.equal(countMatches(segs), 1);
  assert.equal(rebuilt(content, quote), content);
  assert.ok(segs.some((s) => !s.match && s.text.includes("\n")));
  // A quote with a different internal space count does not match.
  assert.equal(countMatches(locateQuote(content, "Persistent  fatigue noted at visit two.")), 0);
});

check("7. empty quote -> whole content as one non-match segment", () => {
  const content = "Any content here.";
  const segs = locateQuote(content, "");
  assert.deepEqual(segs, [{ text: content, match: false }]);
  assert.equal(countMatches(segs), 0);
  assert.equal(rebuilt(content, ""), content);
});

check("8. quote equals the entire content -> single match segment", () => {
  const content = "Each judged likely incidental with no action needed";
  const segs = locateQuote(content, content);
  assert.deepEqual(segs, [{ text: content, match: true }]);
  assert.equal(countMatches(segs), 1);
  assert.equal(rebuilt(content, content), content);
});

check("9. empty content -> single non-match segment, never empty array", () => {
  assert.deepEqual(locateQuote("", "anything"), [{ text: "", match: false }]);
  assert.deepEqual(locateQuote("", ""), [{ text: "", match: false }]);
});

check("10. adjacent matches with no gap between them", () => {
  const content = "abcabcabc";
  const segs = locateQuote(content, "abc");
  assert.equal(countMatches(segs), 3);
  assert.equal(rebuilt(content, "abc"), content);
  assert.ok(segs.every((s) => s.match));
});

check("11. pure: inputs unchanged, output deterministic", () => {
  const content = "Persistent dizziness reported at the most recent visit.";
  const quote = "Persistent dizziness reported at the most recent visit.";
  const a = JSON.stringify(locateQuote(content, quote));
  const b = JSON.stringify(locateQuote(content, quote));
  assert.equal(a, b);
  assert.equal(content, "Persistent dizziness reported at the most recent visit.");
  assert.equal(quote, "Persistent dizziness reported at the most recent visit.");
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
