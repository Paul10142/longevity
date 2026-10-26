/**
 * Stage 1 — query expansion (design §5). One cheap call turns the physician's
 * question into a few search phrasings; the union of their results is the
 * biggest recall lever the question path has (a claim about "interval training
 * at maximal aerobic capacity" is invisible to the words "VO2 max training").
 *
 * Always runs, even for short questions. A failed expansion is not a failed
 * question: retrieval falls back to the question as typed.
 */

import { claudeJson } from '../llm'
import { ASK_EXPAND_MODEL } from './types'

/** The question itself plus up to three rewrites: at most four searches. */
export const MAX_PHRASINGS = 4

const SYSTEM = `You rewrite a physician's question into search phrasings for a library of clinical claims drawn from expert interviews on longevity, exercise, nutrition, sleep, metabolic health and related medicine.

Return STRICT JSON: {"phrasings":["...","..."]}

Write 2 or 3 phrasings. Each must:
- be a short noun phrase or sentence a clinical claim could plausibly be worded like, not a question
- target a DIFFERENT angle of the question (for example the intervention itself, its protocol or dose, its outcomes or risks, a competing approach, the population)
- use plain clinical vocabulary, and a synonym or the spelled-out form when the question uses an abbreviation
- add no fact, number or claim of your own

Do not repeat the question. Do not answer it.`

/** Lowercase-trim-dedupe the question plus the model's phrasings, question first, capped. */
export function normalizePhrasings(question: string, raw: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (s: unknown) => {
    if (typeof s !== 'string') return
    const t = s.replace(/\s+/g, ' ').trim()
    if (t.length < 3 || t.length > 300) return
    const key = t.toLowerCase().replace(/[?.!\s]+$/, '')
    if (seen.has(key)) return
    seen.add(key)
    out.push(t)
  }
  add(question)
  if (Array.isArray(raw)) for (const p of raw) add(p)
  return out.slice(0, MAX_PHRASINGS)
}

export async function expandQuestion(question: string): Promise<string[]> {
  try {
    const res = await claudeJson<{ phrasings?: unknown }>(SYSTEM, question, 500, ASK_EXPAND_MODEL, 'low')
    return normalizePhrasings(question, res.phrasings)
  } catch (e) {
    console.warn(`[ask] expansion failed, searching the question as typed: ${e instanceof Error ? e.message : String(e)}`)
    return normalizePhrasings(question, [])
  }
}
