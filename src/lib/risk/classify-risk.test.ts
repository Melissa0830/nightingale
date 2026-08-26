/**
 * Focused pure-function test for classifyRiskFloor.
 *
 * No test framework is configured in this project (no Jest/Vitest/Mocha),
 * so this uses Node's built-in `assert` module only — no new dependency —
 * run directly via `npx tsx src/lib/risk/classify-risk.test.ts`. Mirrors
 * the same plain PASS/FAIL-print + exit-code convention already used by
 * the project's Python test_*.py files, adapted for a pure TS unit rather
 * than an HTTP/DB integration test (no server, no DB, no network here).
 *
 * Run: npx tsx src/lib/risk/classify-risk.test.ts
 * Exit code: 0 if all cases pass, 1 otherwise.
 */
import assert from "node:assert/strict";
import { classifyRiskFloor } from "./classify-risk";

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

// A. quotedText contains an approved critical phrase.
check("A. quotedText contains 'anaphylaxis' -> critical", () => {
  const result = classifyRiskFloor({
    quotedText: "Patient reports anaphylaxis after taking new medication",
    riskReason: "",
  });
  assert.equal(result, "critical");
});

// B. riskReason contains an approved critical phrase.
check("B. riskReason contains 'chest pain' -> critical", () => {
  const result = classifyRiskFloor({
    quotedText: "",
    riskReason: "Patient presented with chest pain radiating to left arm",
  });
  assert.equal(result, "critical");
});

// C. benign / non-trigger text (mirrors the actual seed Highlight 2 content).
check("C. benign text, no trigger phrase -> unrated", () => {
  const result = classifyRiskFloor({
    quotedText: "Patient reports mild headache for two days",
    riskReason: "Low-risk symptom; monitor only.",
  });
  assert.equal(result, "unrated");
});

// D. case normalization — differently-capitalized critical phrase.
check("D. uppercase 'CHEST PAIN' still matches -> critical", () => {
  const result = classifyRiskFloor({
    quotedText: "Patient reports CHEST PAIN this morning",
    riskReason: "",
  });
  assert.equal(result, "critical");
});

// E. false-positive guard — generic related word ("pain" alone) must not trigger.
check("E. generic 'pain' alone (not 'chest pain') -> unrated", () => {
  const result = classifyRiskFloor({
    quotedText: "Patient reports pain in lower back",
    riskReason: "Chronic pain, not acute.",
  });
  assert.equal(result, "unrated");
});

// F. empty strings.
check("F. empty quotedText and riskReason -> unrated", () => {
  const result = classifyRiskFloor({ quotedText: "", riskReason: "" });
  assert.equal(result, "unrated");
});

// G. one field benign, one field critical.
check("G. benign quotedText + critical riskReason ('suicidal') -> critical", () => {
  const result = classifyRiskFloor({
    quotedText: "Routine follow-up visit",
    riskReason: "Patient mentioned feeling suicidal during consult",
  });
  assert.equal(result, "critical");
});

// Additional trigger coverage: exercise every implemented phrase at least once.
check("I. 'difficulty breathing' trigger -> critical", () => {
  const result = classifyRiskFloor({
    quotedText: "Patient experienced difficulty breathing during the night",
    riskReason: "",
  });
  assert.equal(result, "critical");
});

// H. structural confirmation, not a runtime assertion: classifyRiskFloor's
// type signature only accepts { quotedText, riskReason } — Highlight.importance
// and Highlight.feedback are not part of the input type at all, so they
// cannot influence the result. This is enforced by TypeScript at the call
// site, not by widening the helper's API merely to test that they are
// ignored (which the design review explicitly said not to do).

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
