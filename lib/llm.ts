/**
 * LLM provider helpers.
 *
 * Article generation runs on Claude (Anthropic). Embeddings have no Anthropic
 * equivalent, so those stay on OpenAI (see lib that owns embeddings). Extraction/
 * consolidation still use OpenAI today; they can move here the same way.
 */

import Anthropic from '@anthropic-ai/sdk'

// Default generation model. Opus 4.8 is strong at long-form clinical writing.
export const CLAUDE_MODEL = 'claude-opus-4-8'

let client: Anthropic | null = null
function getAnthropic(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY')
    client = new Anthropic({ apiKey })
  }
  return client
}

/** Pull the first JSON object out of a model response (tolerates ``` fences
 * and stray prose around the JSON). */
function extractJson(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : s
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : body
}

/**
 * Ask Claude for a strict-JSON response and parse it. The system prompt is
 * expected to specify the exact JSON shape (as our synthesis prompts do).
 * No thinking: keeps the output a clean JSON object and the cost predictable.
 */
export async function claudeJson<T>(
  system: string,
  user: string,
  maxTokens = 8000,
  model: string = CLAUDE_MODEL
): Promise<T> {
  const msg = await getAnthropic().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  })
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
  if (!text.trim()) throw new Error('Empty Claude response')
  return JSON.parse(extractJson(text)) as T
}
