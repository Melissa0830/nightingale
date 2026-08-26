import type { ProvenanceType } from "@/generated/prisma/client";

/**
 * The three session types that actually originate an AI-scribed note.
 * "none" is a manual-entry marker, never a valid session type here.
 */
export type SupportedSessionType = Exclude<ProvenanceType, "none">;

export interface LlmAdapter {
  summarize(redactedText: string, sessionType: SupportedSessionType): Promise<string>;
}

/**
 * Deterministic mock adapter. No real LLM call, no external dependency, no
 * API key — see design review for the demo-reliability/deadline rationale.
 *
 * Output is a pure function of its input on purpose: it lets tests prove
 * redaction happened upstream by tracing the persisted summary back to
 * exactly the redactedText this adapter received, never the original
 * rawText. This is NOT a real generative model.
 */
class MockLlmAdapter implements LlmAdapter {
  async summarize(redactedText: string, sessionType: SupportedSessionType): Promise<string> {
    const extract = redactedText.trim().slice(0, 280);
    return `AI Scribe Summary (${sessionType}): ${extract}`;
  }
}

const adapter: LlmAdapter = new MockLlmAdapter();

export function getLlmAdapter(): LlmAdapter {
  return adapter;
}
