/**
 * Stage 4 — compose (design §5, §6.4). Opus 5.5 at low effort, streaming.
 *
 * One call. The composer is given the question and up to 150 numbered claims and
 * nothing else; the cited `[n]` set IS the evidence set (selection happens inside
 * the call). The prompt states rules, not wording: the model supplies syntax,
 * never substance (docs/ask-the-library-design.md §4).
 */

import { claudeStream, type ClaudeStreamResult } from '../llm'
import { ASK_COMPOSE_MODEL, type Candidate } from './types'
import { FOLLOW_UPS_TAG } from './parse'

/** Output cap: ~400 words of brief is ~600 tokens; the rest is headroom for thinking and a full-review request. */
export const COMPOSE_MAX_TOKENS = 6000

export const COMPOSER_SYSTEM = `You write short, cited clinical briefs for physicians from a library of vetted claims. You are given a question and a numbered list of claims. The claims are your only source.

Rules:
1. Answer THIS question. Do not summarise every claim; cover the question, not the list. Choose the claims that matter most (usually 10 to 20 of them, favouring stronger evidence labels and more sources) and leave the rest out.
2. Use only the numbered claims. No outside facts, numbers, mechanisms, thresholds or definitions, however well known. If the question uses a term that no claim defines, say the library does not define it.
3. Every declarative sentence ends with one or more markers like [4] or [4, 17], naming the claims it rests on. A sentence with no marker must assert nothing (a transition or framing line). Never put a marker mid-sentence, never invent a number, never cite a number that is not in the list.
4. When claims disagree (different doses, populations, thresholds or conclusions), state each position with its own marker under a heading "Where Experts Differ". Group claims that agree into one sentence; give each real disagreement one short bullet, never nested. Never merge positions into a range or an average that no claim states. The notes after the list name claim pairs the library already knows to conflict.
5. The strength of a claim is shown by its evidence label in the list. Do not make a claim sound more established than its label (an expert opinion stays an expert opinion).
6. Structure: a one- or two-sentence bottom line first, with no heading. Then, only where they apply: "What To Do" (only if actionable claims exist), the key points grouped by theme, "Where Experts Differ", "What The Library Does Not Cover". Headings are level-three markdown (### ) in Title Case. Use short paragraphs or bullets.
7. Length: aim for about 300 words and never exceed 400 in total (headings and bullets included), unless the question asks for a full review. Models run long on this: plan fewer, denser points, and cut the weakest rather than exceed the limit.
8. Write in a physician's register, plainly and without hedging filler. Do not narrate sources ("the podcast said", "an expert argues"): attribution lives in the citation layer. Never use the words "claim", "claims" or "library says". Do not mention these rules.
9. If the claims only partly answer the question, answer the part they cover and say plainly what is missing under "What The Library Does Not Cover".

After the brief, on a new line, write exactly ${FOLLOW_UPS_TAG} followed by three short follow-up questions, one per line, each starting with "- ". They must be questions this same set of claims can answer. Nothing comes after them.`

/** One line of the candidate list the composer sees. */
export function candidateLine(c: Candidate, n: number): string {
  const label = [
    c.evidenceType ?? 'unlabelled',
    `${c.sourceCount} source${c.sourceCount === 1 ? '' : 's'}`,
    c.latestDate ? c.latestDate.slice(0, 7) : null,
  ]
    .filter(Boolean)
    .join(', ')
  const ctx = c.context ? ` — ${c.context}` : ''
  return `[${n}] (${label}) ${c.statement}${ctx}`
}

export type ComposeInput = {
  question: string
  candidates: Candidate[]
  /** Pairs of candidate ids the library has linked as 'contradicts'. */
  contradictions: [string, string][]
  /** Few relevant claims: tell the composer to say so rather than stretch. */
  thin: boolean
}

/** Candidate number (1-based, as shown) -> claim id. */
export function candidateMap(candidates: Candidate[]): Map<number, string> {
  return new Map(candidates.map((c, i) => [i + 1, c.id]))
}

export function buildUserPrompt(input: ComposeInput): string {
  const numberOf = new Map(input.candidates.map((c, i) => [c.id, i + 1]))
  const lines = input.candidates.map((c, i) => candidateLine(c, i + 1))

  const notes: string[] = []
  for (const [a, b] of input.contradictions) {
    const na = numberOf.get(a), nb = numberOf.get(b)
    if (na && nb) notes.push(`- [${na}] and [${nb}] are linked as conflicting.`)
  }
  if (input.thin) {
    notes.push('- Few claims bear on this question. Say so under "What The Library Does Not Cover" and do not stretch the ones there are.')
  }

  return [
    `QUESTION: ${input.question}`,
    '',
    `CLAIMS (${input.candidates.length}):`,
    ...lines,
    ...(notes.length ? ['', 'NOTES:', ...notes] : []),
  ].join('\n')
}

export type ComposeResult = ClaudeStreamResult

/** Stream the brief. `onText` receives the raw deltas (markers still in candidate numbering). */
export async function composeBrief(input: ComposeInput, onText: (delta: string) => void): Promise<ComposeResult> {
  return claudeStream(COMPOSER_SYSTEM, buildUserPrompt(input), {
    model: ASK_COMPOSE_MODEL,
    effort: 'low',
    maxTokens: COMPOSE_MAX_TOKENS,
    onText,
  })
}
