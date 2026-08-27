/**
 * Focused pure tests for the central PHI redaction gateway.
 *
 * Convention matches src/lib/risk/classify-risk.test.ts: Node's built-in
 * assert only, plain PASS/FAIL print + exit code. The HTTP-level behaviour
 * (all AI Scribe ingestion routed through redactPHI, redacted text persisted)
 * is covered by test_ai_scribe_ingestion.py; this file locks the pure
 * function's contract directly.
 *
 * Run: npx tsx src/lib/security/redact-phi.test.ts
 */
import assert from "node:assert/strict";
import { redactPHI } from "./redact-phi";

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

// ─── Known names (caller-supplied) ──────────────────────────────────────
check("1. known patient/user name -> [NAME], case-insensitive", () => {
  const out = redactPHI("Reviewed with joanne tan today.", ["Joanne Tan"]);
  assert.ok(!/joanne/i.test(out));
  assert.ok(out.includes("[NAME]"));
});

check("2. shorter known name does not eat a longer unrelated word", () => {
  const out = redactPHI("Tanya reported improvement.", ["Tan"]);
  assert.equal(out, "Tanya reported improvement.");
});

// ─── Title-prefixed unknown-name fallback ───────────────────────────────
check("3. 'Dr Alice Lee' collapses to a single [NAME] (no residual surname)", () => {
  const out = redactPHI("Referred by Dr Alice Lee for review.", []);
  assert.ok(out.includes("[NAME]"));
  assert.ok(!out.includes("Lee"));
});

check("4. title fallback preserves the trailing clinical phrase", () => {
  const out = redactPHI("Dr Alice Lee General Surgery consulted.", []);
  assert.ok(out.includes("[NAME]"));
  assert.ok(out.includes("General Surgery"));
});

check("5. ordinary Title-Case clinical phrases are NOT redacted as names", () => {
  const out = redactPHI("Blood Pressure and Chest Pain discussed.", []);
  assert.ok(!out.includes("[NAME]"));
  assert.ok(out.includes("Blood Pressure"));
  assert.ok(out.includes("Chest Pain"));
});

// ─── NRIC / FIN ────────────────────────────────────────────────────────
check("6. Singapore NRIC -> [ID_NUMBER]", () => {
  const out = redactPHI("ID S1234567A on file.", []);
  assert.ok(!out.includes("S1234567A"));
  assert.ok(out.includes("[ID_NUMBER]"));
});

check("7. NRIC redaction is case-insensitive (fail-safe)", () => {
  const out = redactPHI("id s1234567a", []);
  assert.ok(out.includes("[ID_NUMBER]"));
});

// ─── Phone ─────────────────────────────────────────────────────────────
check("8. +65 mobile with and without separators -> [PHONE]", () => {
  for (const p of ["+65 9123 4567", "+6591234567", "91234567", "9123-4567"]) {
    const out = redactPHI(`Call ${p} to confirm.`, []);
    assert.ok(out.includes("[PHONE]"), `expected [PHONE] for "${p}" -> ${out}`);
  }
});

check("9. legacy dash-4-3-3 example -> [PHONE]", () => {
  const out = redactPHI("Old contact 0912-345-678.", []);
  assert.ok(out.includes("[PHONE]"));
});

// ─── Benign clinical values MUST survive ───────────────────────────────
check("10. medication dose, BP reading, and durations are not redacted", () => {
  const input = "Paracetamol 500mg PRN, BP 118/76, review in 2 weeks; max 3x/day.";
  const out = redactPHI(input, ["Joanne Tan"]);
  assert.equal(out, input);
});

check("11. an 11-digit record number is not carved into a phone", () => {
  const out = redactPHI("Record 12345678901 archived.", []);
  assert.ok(!out.includes("[PHONE]"));
  assert.ok(out.includes("12345678901"));
});

// ─── Mixed input ──────────────────────────────────────────────────────
check("12. mixed PHI: name + phone + ID all masked, clinical tail intact", () => {
  const out = redactPHI(
    "Joanne Tan, phone +65 9123 4567, ID S1234567A reported mild symptoms, BP 118/76.",
    ["Joanne Tan"],
  );
  assert.ok(!/joanne/i.test(out));
  assert.ok(!out.includes("9123 4567"));
  assert.ok(!out.includes("S1234567A"));
  assert.ok(out.includes("[NAME]"));
  assert.ok(out.includes("[PHONE]"));
  assert.ok(out.includes("[ID_NUMBER]"));
  assert.ok(out.includes("mild symptoms"));
  assert.ok(out.includes("118/76"));
});

check("13. pure function: same input -> same output, input string unchanged", () => {
  const input = "Joanne Tan, S1234567A";
  const a = redactPHI(input, ["Joanne Tan"]);
  const b = redactPHI(input, ["Joanne Tan"]);
  assert.equal(a, b);
  assert.equal(input, "Joanne Tan, S1234567A");
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
