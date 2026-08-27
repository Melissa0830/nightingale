/**
 * Focused pure tests for deterministic lexical-overlap grouping (v2 Phase 11).
 *
 * Convention matches src/lib/risk/classify-risk.test.ts. Also prints a small
 * transparent calibration table (expected matches + expected non-matches)
 * so the fixed thresholds are visibly justified, not silently tuned.
 *
 * Run: npx tsx src/lib/highlights/lexical-grouping.test.ts
 */
import assert from "node:assert/strict";
import { normalizeRiskReason } from "./derive-adaptive-priority";
import {
  jaccard,
  tokenizeRiskReason,
  resolveRiskReasonBucket,
  LEXICAL_JACCARD_THRESHOLD,
  LEXICAL_MIN_SHARED_TOKENS,
  type LexicalBucket,
} from "./lexical-grouping";

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

function bucket(key: string, representativeId: string, riskReason: string): LexicalBucket {
  return {
    key,
    representativeId,
    representativeRiskReason: riskReason,
    tokenSet: tokenizeRiskReason(normalizeRiskReason(riskReason)),
  };
}

const X = bucket(
  normalizeRiskReason("Persistent symptoms may require follow-up."),
  "hl-x",
  "Persistent symptoms may require follow-up.",
);
const Y = bucket(
  normalizeRiskReason("Medication review advised at next visit."),
  "hl-y",
  "Medication review advised at next visit.",
);

function resolve(reason: string, buckets: readonly LexicalBucket[]) {
  return resolveRiskReasonBucket(normalizeRiskReason(reason), buckets);
}

// ─── §11K required cases ─────────────────────────────────────────────────

check("1. identical normalized phrase -> exact", () => {
  const r = resolve("Persistent symptoms may require follow-up.", [X, Y]);
  assert.equal(r.matchMethod, "exact");
  assert.equal(r.lexicalOverlapScore, 1);
  assert.equal(r.matchedBucketRepresentativeId, "hl-x");
});

check("2. case / punctuation / repeated whitespace only -> exact", () => {
  const r = resolve("  persistent   SYMPTOMS may require follow-up ", [X, Y]);
  assert.equal(r.matchMethod, "exact");
  assert.equal(r.matchedKey, X.key);
});

check("3. partial wording overlap, enough tokens + Jaccard -> lexical", () => {
  // tokens {persistent, respiratory, symptoms, may, require, follow-up} (6)
  // vs X {persistent, symptoms, may, require, follow-up} (5): shared 5, union 6
  const r = resolve("Persistent respiratory symptoms may require follow-up.", [X, Y]);
  assert.equal(r.matchMethod, "lexical");
  assert.ok(r.lexicalOverlapScore !== null && r.lexicalOverlapScore >= LEXICAL_JACCARD_THRESHOLD);
  assert.equal(r.matchedBucketRepresentativeId, "hl-x");
});

check("4. Jaccard high but shared tokens below minimum -> none", () => {
  // candidate {swelling} vs bucket {swelling}: shared 1 (< 2), jaccard 1.0
  const solo = bucket("swelling", "hl-s", "swelling");
  const r = resolveRiskReasonBucket("swelling noted", [solo]); // tokens {swelling, noted}
  // shared with {swelling} = 1 < LEXICAL_MIN_SHARED_TOKENS
  assert.equal(LEXICAL_MIN_SHARED_TOKENS, 2);
  assert.equal(r.matchMethod, "none");
});

check("5. shared tokens ok but Jaccard below threshold -> none", () => {
  // candidate {persistent, symptoms, unrelated, extra, words, here, plus, more}
  // vs X {persistent, symptoms, may, require, follow-up}: shared 2, union 11 -> ~0.18
  const r = resolve(
    "Persistent symptoms unrelated extra words here plus more.",
    [X, Y],
  );
  assert.ok(jaccard(tokenizeRiskReason(normalizeRiskReason("Persistent symptoms unrelated extra words here plus more.")), X.tokenSet) < LEXICAL_JACCARD_THRESHOLD);
  assert.equal(r.matchMethod, "none");
});

check("6. unrelated reasons -> none", () => {
  const r = resolve("Blood pressure trending upward over three visits.", [X, Y]);
  assert.equal(r.matchMethod, "none");
});

check("7. same input repeated -> identical method/score", () => {
  const a = resolve("Persistent respiratory symptoms may require follow-up.", [X, Y]);
  const b = resolve("Persistent respiratory symptoms may require follow-up.", [Y, X]);
  assert.equal(a.matchMethod, b.matchMethod);
  assert.equal(a.lexicalOverlapScore, b.lexicalOverlapScore);
  assert.equal(a.matchedBucketRepresentativeId, b.matchedBucketRepresentativeId);
});

check("8. candidate matches two buckets, different scores -> highest wins", () => {
  // P {alpha,beta,gamma}  Q {alpha,beta,gamma,delta,epsilon,zeta}
  const P = bucket("alpha beta gamma", "hl-p", "alpha beta gamma");
  const Q = bucket(
    "alpha beta gamma delta epsilon zeta",
    "hl-q",
    "alpha beta gamma delta epsilon zeta",
  );
  // candidate {alpha,beta,gamma,delta} (key differs from both):
  //   vs P: shared 3, union 4 -> 0.75
  //   vs Q: shared 4, union 6 -> ~0.667
  const r = resolveRiskReasonBucket("alpha beta gamma delta", [Q, P]);
  assert.equal(r.matchMethod, "lexical");
  assert.equal(r.matchedBucketRepresentativeId, "hl-p");
  assert.equal(r.lexicalOverlapScore, 0.75);
});

check("9. candidate matches two buckets with EQUAL score -> representative id ASC", () => {
  // Two buckets, both {alpha, beta, gamma, delta}; candidate {alpha, beta, gamma, delta}
  const B1 = bucket("k1", "hl-zzz", "alpha beta gamma delta");
  const B2 = bucket("k2", "hl-aaa", "alpha beta gamma delta");
  const first = resolveRiskReasonBucket("alpha beta gamma delta", [B1, B2]);
  const second = resolveRiskReasonBucket("alpha beta gamma delta", [B2, B1]);
  assert.equal(first.matchedBucketRepresentativeId, "hl-aaa");
  assert.equal(second.matchedBucketRepresentativeId, "hl-aaa");
  assert.equal(first.lexicalOverlapScore, second.lexicalOverlapScore);
});

check("10. different bucket array ordering -> same resolved bucket", () => {
  const reason = "Persistent respiratory symptoms may require follow-up.";
  const orders: LexicalBucket[][] = [
    [X, Y],
    [Y, X],
  ];
  const ids = orders.map((o) => resolve(reason, o).matchedBucketRepresentativeId);
  assert.deepEqual(ids, ["hl-x", "hl-x"]);
});

check("11. empty bucket list -> none (no crash)", () => {
  const r = resolve("anything at all here", []);
  assert.equal(r.matchMethod, "none");
  assert.equal(r.lexicalOverlapScore, null);
});

// ─── Transparent calibration table (printed, plus assertions) ────────────
console.log("\n-- lexical calibration (threshold: shared >= "
  + `${LEXICAL_MIN_SHARED_TOKENS}, jaccard >= ${LEXICAL_JACCARD_THRESHOLD}) --`);

const calibration: { label: string; reason: string; expect: "match" | "no-match" }[] = [
  { label: "insert one word", reason: "Persistent respiratory symptoms may require follow-up.", expect: "match" },
  { label: "reorder + drop period", reason: "symptoms persistent may require follow-up", expect: "match" },
  { label: "drop one word", reason: "Persistent symptoms require follow-up.", expect: "match" },
  { label: "two shared, lots of noise", reason: "Persistent symptoms unrelated extra words here plus more.", expect: "no-match" },
  { label: "one shared word only", reason: "Persistent hypertension noted today.", expect: "no-match" },
  { label: "different domain", reason: "Medication review advised at next visit.", expect: "no-match" },
];

for (const c of calibration) {
  const toks = tokenizeRiskReason(normalizeRiskReason(c.reason));
  const shared = [...toks].filter((t) => X.tokenSet.has(t)).length;
  const score = jaccard(toks, X.tokenSet);
  const r = resolve(c.reason, [X]);
  console.log(
    `  ${c.label.padEnd(26)} shared=${shared} jaccard=${score.toFixed(3)} `
      + `method=${r.matchMethod.padEnd(7)} (expected ${c.expect})`,
  );
  check(`calibration: "${c.label}" -> ${c.expect}`, () => {
    if (c.expect === "match") assert.equal(r.matchMethod, "lexical");
    else assert.notEqual(r.matchMethod, "lexical");
  });
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
