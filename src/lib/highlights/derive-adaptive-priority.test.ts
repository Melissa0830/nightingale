/**
 * Focused pure-function tests for the adaptive Highlight prioritization
 * helper (Bonus).
 *
 * Same convention as src/lib/risk/classify-risk.test.ts: no test framework
 * is configured in this project, so this uses Node's built-in `assert` only
 * and the plain PASS/FAIL-print + exit-code style shared with the Python
 * test_*.py files.
 *
 * Run: npx tsx src/lib/highlights/derive-adaptive-priority.test.ts
 * Exit code: 0 if all cases pass, 1 otherwise.
 */
import assert from "node:assert/strict";
import {
  deriveAdaptivePriority,
  normalizeRiskReason,
} from "./derive-adaptive-priority";
import { classifyRiskFloor } from "../risk/classify-risk";

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

// ─── §35 required formula cases ───────────────────────────────────────────

check("1. 0 accepted / 0 rejected -> adjustment 0 (no feedback)", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 0, rejectedCount: 0 });
  assert.equal(r.feedbackCount, 0);
  assert.equal(r.learnedAdjustment, 0);
  assert.equal(r.effectiveImportance, 0);
});

check("2. 1 accepted / 0 rejected -> adjustment 0 (below threshold)", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 1, rejectedCount: 0 });
  assert.equal(r.feedbackCount, 1);
  assert.equal(r.learnedAdjustment, 0);
  assert.equal(r.effectiveImportance, 0);
});

check("3. 2 accepted / 0 rejected -> adjustment 0 (below threshold)", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 2, rejectedCount: 0 });
  assert.equal(r.feedbackCount, 2);
  assert.equal(r.learnedAdjustment, 0);
  assert.equal(r.effectiveImportance, 0);
});

check("4. 3 accepted / 0 rejected -> adjustment +2, effective 0+2=2", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 3, rejectedCount: 0 });
  assert.equal(r.feedbackCount, 3);
  assert.equal(r.learnedAdjustment, 2);
  assert.equal(r.effectiveImportance, 2);
});

check("5. 2 accepted / 1 rejected -> adjustment +1 (nonPending 3)", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 2, rejectedCount: 1 });
  assert.equal(r.feedbackCount, 3);
  assert.equal(r.learnedAdjustment, 1);
  assert.equal(r.effectiveImportance, 1);
});

check("6. 1 accepted / 2 rejected -> adjustment -1 (nonPending 3)", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 1, rejectedCount: 2 });
  assert.equal(r.feedbackCount, 3);
  assert.equal(r.learnedAdjustment, -1);
  assert.equal(r.effectiveImportance, -1);
});

check("7. 0 accepted / 3 rejected -> adjustment -2", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 0, rejectedCount: 3 });
  assert.equal(r.feedbackCount, 3);
  assert.equal(r.learnedAdjustment, -2);
  assert.equal(r.effectiveImportance, -2);
});

check("8. positive clamp: 10 accepted / 0 rejected -> +2 (not +10)", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 10, rejectedCount: 0 });
  assert.equal(r.learnedAdjustment, 2);
  assert.equal(r.effectiveImportance, 2);
});

check("9. negative clamp: 0 accepted / 10 rejected -> -2 (not -10)", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 0, rejectedCount: 10 });
  assert.equal(r.learnedAdjustment, -2);
  assert.equal(r.effectiveImportance, -2);
});

check("10. base importance preserved: base 5, 3 accepted -> base stays 5", () => {
  const input = { baseImportance: 5, acceptedCount: 3, rejectedCount: 0 };
  const r = deriveAdaptivePriority(input);
  assert.equal(input.baseImportance, 5, "input object must not be mutated");
  assert.equal(r.learnedAdjustment, 2);
});

check("11. effectiveImportance = base + adjustment: base 5, 3 accepted -> 7", () => {
  const r = deriveAdaptivePriority({ baseImportance: 5, acceptedCount: 3, rejectedCount: 0 });
  assert.equal(r.effectiveImportance, 7);
});

// §33 riskFloor independence: a critical deterministic floor is unaffected by
// a maximally-negative adaptive adjustment. The helper does not even accept
// riskFloor as input, so this composes the two independently and asserts the
// floor is unchanged.
check("12. riskFloor independence: critical stays critical under adjustment -2", () => {
  const floorBefore = classifyRiskFloor({
    quotedText: "Patient reports chest pain radiating to left arm",
    riskReason: "Possible cardiac event",
  });
  assert.equal(floorBefore, "critical");

  const r = deriveAdaptivePriority({ baseImportance: 3, acceptedCount: 0, rejectedCount: 10 });
  assert.equal(r.learnedAdjustment, -2);
  assert.equal(r.effectiveImportance, 1);

  const floorAfter = classifyRiskFloor({
    quotedText: "Patient reports chest pain radiating to left arm",
    riskReason: "Possible cardiac event",
  });
  assert.equal(floorAfter, "critical", "adaptive adjustment must not touch riskFloor");
});

// ─── normalization ───────────────────────────────────────────────────────

check("N1. normalization: case + trailing period + extra spaces collapse to one bucket", () => {
  const a = normalizeRiskReason("Persistent symptoms may require follow-up.");
  const b = normalizeRiskReason("  persistent   symptoms may require follow-up ");
  const c = normalizeRiskReason("Persistent  symptoms may  require follow-up.");
  assert.equal(a, "persistent symptoms may require follow-up");
  assert.equal(b, a);
  assert.equal(c, a);
});

check("N2. normalization keeps distinct reasons distinct (no semantic merging)", () => {
  assert.notEqual(
    normalizeRiskReason("Persistent symptoms may require follow-up."),
    normalizeRiskReason("Medication review advised at next visit."),
  );
});

// ─── v2 Phases 4-6: reviewCount / acceptanceRate / learningStatus ─────────

check("S0. 0/0 -> reviewCount 0, acceptanceRate null, status no_feedback, adj 0", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 0, rejectedCount: 0 });
  assert.equal(r.reviewCount, 0);
  assert.equal(r.acceptanceRate, null);
  assert.equal(r.learningStatus, "no_feedback");
  assert.equal(r.learnedAdjustment, 0);
});

check("S1. 1/0 -> reviewCount 1, status gathering_feedback, adj 0", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 1, rejectedCount: 0 });
  assert.equal(r.reviewCount, 1);
  assert.equal(r.learningStatus, "gathering_feedback");
  assert.equal(r.acceptanceRate, 1);
  assert.equal(r.learnedAdjustment, 0);
});

check("S2. 2/0 -> reviewCount 2, status gathering_feedback, adj 0", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 2, rejectedCount: 0 });
  assert.equal(r.reviewCount, 2);
  assert.equal(r.learningStatus, "gathering_feedback");
  assert.equal(r.learnedAdjustment, 0);
});

check("S3. 3/0 -> reviewCount 3, acceptanceRate 1, status adaptive, adj +2", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 3, rejectedCount: 0 });
  assert.equal(r.reviewCount, 3);
  assert.equal(r.acceptanceRate, 1);
  assert.equal(r.learningStatus, "adaptive");
  assert.equal(r.learnedAdjustment, 2);
});

check("S4. 2/1 -> acceptanceRate 2/3, status adaptive, adj +1", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 2, rejectedCount: 1 });
  assert.equal(r.acceptanceRate, 2 / 3);
  assert.equal(r.learningStatus, "adaptive");
  assert.equal(r.learnedAdjustment, 1);
});

check("S5. 1/2 -> acceptanceRate 1/3, status adaptive, adj -1", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 1, rejectedCount: 2 });
  assert.equal(r.acceptanceRate, 1 / 3);
  assert.equal(r.learningStatus, "adaptive");
  assert.equal(r.learnedAdjustment, -1);
});

check("S6. 0/3 -> acceptanceRate 0, status adaptive, adj -2", () => {
  const r = deriveAdaptivePriority({ baseImportance: 0, acceptedCount: 0, rejectedCount: 3 });
  assert.equal(r.acceptanceRate, 0);
  assert.equal(r.learningStatus, "adaptive");
  assert.equal(r.learnedAdjustment, -2);
});

check("S7. base importance unchanged by the evidence fields (base 5, 3/0 -> eff 7)", () => {
  const input = { baseImportance: 5, acceptedCount: 3, rejectedCount: 0 };
  const r = deriveAdaptivePriority(input);
  assert.equal(input.baseImportance, 5);
  assert.equal(r.effectiveImportance, 7);
  assert.equal(r.reviewCount, 3);
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
