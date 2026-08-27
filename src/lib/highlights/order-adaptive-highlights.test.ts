/**
 * Focused pure tests for the safety-first Highlight comparator (v2 Phase 3).
 *
 * Convention matches src/lib/risk/classify-risk.test.ts: Node's built-in
 * assert only, plain PASS/FAIL print + exit code.
 *
 * Run: npx tsx src/lib/highlights/order-adaptive-highlights.test.ts
 */
import assert from "node:assert/strict";
import {
  compareHighlightPriority,
  orderHighlightsBySafetyThenPriority,
  type OrderableHighlight,
} from "./order-adaptive-highlights";

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

const at = "2026-08-27T10:00:00.000Z";

// A. critical (low adaptive) always outranks unrated (high adaptive).
check("A. critical/-2 sorts before unrated/+10", () => {
  const critical: OrderableHighlight = { riskFloor: "critical", effectiveImportance: -2, createdAt: at, id: "b" };
  const unrated: OrderableHighlight = { riskFloor: "unrated", effectiveImportance: 10, createdAt: at, id: "a" };
  assert.ok(compareHighlightPriority(critical, unrated) < 0);
  const ordered = orderHighlightsBySafetyThenPriority([unrated, critical]);
  assert.deepEqual(ordered.map((h) => h.id), ["b", "a"]);
});

// B. within the same floor, higher effectiveImportance first.
check("B. unrated/+2 sorts before unrated/+1", () => {
  const hi: OrderableHighlight = { riskFloor: "unrated", effectiveImportance: 2, createdAt: at, id: "a" };
  const lo: OrderableHighlight = { riskFloor: "unrated", effectiveImportance: 1, createdAt: at, id: "b" };
  assert.ok(compareHighlightPriority(hi, lo) < 0);
  assert.deepEqual(orderHighlightsBySafetyThenPriority([lo, hi]).map((h) => h.id), ["a", "b"]);
});

// C. same floor + same score -> createdAt DESC, then id ASC.
check("C. same floor+score: newer createdAt first, then id ASC", () => {
  const older: OrderableHighlight = { riskFloor: "unrated", effectiveImportance: 0, createdAt: "2026-08-27T09:00:00.000Z", id: "z" };
  const newerA: OrderableHighlight = { riskFloor: "unrated", effectiveImportance: 0, createdAt: "2026-08-27T11:00:00.000Z", id: "m" };
  const newerB: OrderableHighlight = { riskFloor: "unrated", effectiveImportance: 0, createdAt: "2026-08-27T11:00:00.000Z", id: "d" };
  const ordered = orderHighlightsBySafetyThenPriority([older, newerA, newerB]);
  // newer-first, then id ASC among the equal-timestamp pair
  assert.deepEqual(ordered.map((h) => h.id), ["d", "m", "z"]);
});

// D. repeated execution -> identical order (deterministic, input unchanged).
check("D. repeated sort is identical and does not mutate input", () => {
  const input: OrderableHighlight[] = [
    { riskFloor: "unrated", effectiveImportance: 1, createdAt: at, id: "c" },
    { riskFloor: "critical", effectiveImportance: -1, createdAt: at, id: "b" },
    { riskFloor: "unrated", effectiveImportance: 3, createdAt: at, id: "a" },
  ];
  const snapshot = input.map((h) => h.id);
  const first = orderHighlightsBySafetyThenPriority(input).map((h) => h.id);
  const second = orderHighlightsBySafetyThenPriority(input).map((h) => h.id);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ["b", "a", "c"]);
  assert.deepEqual(input.map((h) => h.id), snapshot, "input array must not be mutated");
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
