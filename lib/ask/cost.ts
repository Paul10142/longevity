/**
 * List prices (USD per million tokens) for the models the question path uses,
 * as of 2026-10 (docs/ask-the-library-design.md §7). Thinking tokens are billed
 * as output and already counted in `output_tokens`. Embeddings are priced
 * separately and are well under a tenth of a cent per question, so not tracked.
 */
export const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES_PER_MTOK[model]
  if (!p) return 0
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000
}
