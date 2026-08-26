/**
 * Central PHI redaction gateway. Every string sent to an LLM must pass
 * through this function first — no inline regex anywhere else.
 *
 * Pure and synchronous: no Prisma import, no DB, no I/O, no logging.
 * `knownNames` must be gathered by the caller (route layer) from the DB
 * *after* clinic authorization has passed — this function never looks
 * anything up itself.
 *
 * Singapore-first prototype heuristic, NOT a medical-grade NER/DLP solution.
 * Known limitations (documented in README):
 *   - The unknown-name fallback only fires on an explicit person-title
 *     prefix (Dr/Mr/Mrs/Ms); a name with no title and not in knownNames is
 *     missed entirely rather than guessed at. This is a deliberate
 *     narrowing — a generic two-word Title-Case heuristic was tried and
 *     rejected because it both over-redacted ordinary clinical phrases
 *     (e.g. "Chest Pain", "Blood Pressure") AND, worse, under-redacted
 *     three-token names by only consuming the first two tokens and leaving
 *     a real surname exposed (e.g. "Dr Alice Lee" -> "[NAME] Lee").
 *   - The title-prefixed fallback matches AT MOST two name tokens after the
 *     title (e.g. "Dr Alice Lee"). This is a deliberate precision/coverage
 *     trade-off: an unbounded token count was tried and rejected because it
 *     swallowed whatever Title-Case clinical text followed a name with no
 *     lowercase word in between (e.g. "Dr Alice Lee General Surgery" ->
 *     "[NAME]", losing "General Surgery" entirely). The trade-off is that
 *     an unknown THREE-token name is only partially redacted — e.g.
 *     "Dr Tan Wei Ming" -> "[NAME] Ming" — because the fallback cannot
 *     distinguish a third genuine name token from the start of an unrelated
 *     capitalized phrase. This is an accepted prototype limitation, not a
 *     bug: system-known Patient/User names (any token count) are already
 *     fully covered by knownNames exact whole-name matching above, which is
 *     the primary name-redaction mechanism — this fallback only ever
 *     handles names NOT in that list (e.g. an external referring doctor
 *     mentioned in free text).
 *   - NRIC/FIN pattern matches the Singapore format (letter + 7 digits +
 *     letter); phone pattern is Singapore-first (+65, 8-digit local numbers
 *     starting 6/8/9), plus a narrow dash-4-3-3 fallback kept only for the
 *     non-Singapore example already documented in requirements.md /
 *     execution-plan.md. Neither is an exhaustive international format.
 */
export function redactPHI(input: string, knownNames: string[]): string {
  let result = input;

  // 1. Known names (target Patient.displayName + same-clinic User.name),
  //    case-insensitive, whole-name-boundary match. Longest-first so a
  //    short name cannot partially consume a longer name that contains it.
  //    `\b...\b` around the (escaped) name ensures only a complete name
  //    token/phrase matches — a short knownName like "Tan" cannot eat part
  //    of an unrelated longer word like "Tanya".
  const sortedNames = [...new Set(knownNames.map((n) => n.trim()).filter((n) => n.length > 0))]
    .sort((a, b) => b.length - a.length);
  for (const name of sortedNames) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi"), "[NAME]");
  }

  // 2. Unknown-name fallback: fires ONLY on an explicit person-title prefix
  //    (Dr/Mr/Mrs/Ms, optional trailing period) followed by ONE OR TWO
  //    Title-Case name tokens (bounded, not unlimited `*`) — the whole
  //    title+name phrase collapses to a single [NAME], e.g.
  //    "Dr Alice Lee" -> "[NAME]", never "[NAME] Lee". The bound is a
  //    deliberate precision/clinical-text-preservation trade-off (see file
  //    header): "Dr Alice Lee General Surgery" -> "[NAME] General Surgery",
  //    not a single swallowed "[NAME]". An unknown THREE-token name (e.g.
  //    "Dr Tan Wei Ming") is only partially redacted as a result — an
  //    accepted prototype limitation, not NER. A name with no title prefix
  //    and not in knownNames is simply missed.
  result = result.replace(
    /\b(?:Dr|Mr|Mrs|Ms)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g,
    "[NAME]",
  );

  // 3. Singapore NRIC / FIN: one prefix letter (S/T for citizens/PR, F/G for
  //    foreigners) + 7 digits + one checksum letter, e.g. S1234567A.
  //    Case-insensitive by design (fail-safe, not input-validation): a
  //    non-standard-case ID is still sensitive and must still be redacted.
  result = result.replace(/\b[STFG]\d{7}[A-Z]\b/gi, "[ID_NUMBER]");

  // 4. Singapore phone numbers: optional +65 country code (with or without
  //    a separator, including directly attached e.g. +6591234567) + an
  //    8-digit local number starting with 6, 8, or 9, optionally split
  //    4+4 with a space/hyphen. Lookarounds (not \b) anchor both ends so a
  //    valid 8-digit window is never carved out of a longer digit run
  //    (e.g. an 11-digit record number) and a plain digit immediately
  //    before/after never falsely extends or truncates a match.
  result = result.replace(
    /(?<!\d)(?:\+65[\s-]?)?[689]\d{3}[\s-]?\d{4}(?!\d)/g,
    "[PHONE]",
  );

  // 5. Legacy compatibility fallback ONLY: the non-Singapore dash-4-3-3
  //    example (e.g. 0912-345-678) from requirements.md / execution-plan.md.
  //    Not the primary Singapore format — kept narrow (dash-only, fixed
  //    4-3-3 grouping) so it cannot weaken the Singapore-first pattern above
  //    or over-redact ordinary numeric clinical values.
  result = result.replace(/\b\d{4}-\d{3}-\d{3}\b/g, "[PHONE]");

  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
