/**
 * Transcript hygiene — a trust filter, not tidiness (permanent ingestion rule).
 *
 * See docs/v4-build-risks-and-cost.md §D Phase 1 and BACKLOG.md "Transcript
 * hygiene". Ingested transcripts (YouTube captions AND pasted text) carry
 * cold-open hype clips, sponsor reads / ad breaks, and subscribe/outro segments.
 * Extraction cannot tell a sponsor read ("brought to you by AG1, which supports
 * gut health") from a clinical statement, so left in, an ad becomes a *claim*
 * and pollutes the one source of truth with advertising presented as medical
 * guidance — a direct principle-1 violation.
 *
 * This is a cheap Haiku pass that MARKS non-content spans and removes them
 * BEFORE chunking. It is deliberately CONSERVATIVE: it only removes a span it
 * can locate verbatim and unambiguously, it never touches substantive medical
 * content, and — when unsure — it keeps the text and surfaces it for review
 * rather than deleting silently.
 *
 * Kept as a clearly separable function: `stripNonContent(transcript)` in →
 * `{ cleaned, removed }` out. Extraction wires it in at chunk-creation time;
 * nothing else in the pipeline depends on it.
 */

import { claudeJson, CLAUDE_BULK_MODEL } from './llm'

export type RemovedSpan = {
  kind: 'intro' | 'outro' | 'sponsor' | 'ad' | 'other'
  reason: string
  preview: string
  start: number
  end: number
}

export type HygieneResult = {
  cleaned: string
  removed: RemovedSpan[]
}

// LLM output shape: verbatim anchors bounding each non-content span. We ask for
// short start/end snippets rather than offsets (models cannot count chars
// reliably) or the whole cleaned text (huge, truncation-prone on 2-hour
// transcripts).
type SpanMark = {
  kind?: string
  reason?: string
  start_text?: string
  end_text?: string
}

const HYGIENE_SYSTEM_PROMPT = `
You clean podcast / video transcripts for a medical knowledge base BEFORE any
information is extracted from them. Your ONLY job is to identify NON-CONTENT
spans that must be removed so that advertising and channel boilerplate are never
mistaken for medical claims.

REMOVE only these span types:
- intro: cold-open hype, "welcome to the show", host/guest introductions and
  bios, episode housekeeping.
- outro: sign-offs, "thanks for listening", subscribe/like/follow/leave-a-review
  asks, "see you next week", credits.
- sponsor / ad: read-aloud advertisements and promo codes ("this episode is
  brought to you by...", "use code ... for 20% off", "go to example.com/show").

NEVER remove substantive discussion — mechanisms, studies, doses, protocols,
clinical reasoning, Q&A about the actual topic. When a span is ambiguous, or an
ad is interwoven with real content, KEEP IT. Precision over recall: it is far
worse to delete a real medical statement than to leave one ad in.

For each span to remove, return the SHORTEST verbatim snippet (copied
character-for-character from the transcript) that marks where the span STARTS and
where it ENDS. These must appear exactly in the transcript so they can be located.

OUTPUT (STRICT JSON):
{"spans":[{"kind":"intro|outro|sponsor|ad","reason":"...","start_text":"exact words where the span begins","end_text":"exact words where the span ends"}]}
If the transcript is already clean, return {"spans":[]}.
`.trim()

const ANCHOR_MIN = 12 // ignore anchors too short to locate unambiguously

/**
 * Strip intro/outro/sponsor/ad spans from a transcript.
 *
 * Conservative and non-throwing: on any LLM or parse failure it returns the
 * original transcript unchanged with an empty `removed` list (keep, don't
 * delete). Callers should treat `removed` as a review surface.
 */
export async function stripNonContent(transcript: string): Promise<HygieneResult> {
  const text = transcript ?? ''
  if (text.trim().length < 200) return { cleaned: text, removed: [] }

  let marks: SpanMark[]
  try {
    const parsed = await claudeJson<{ spans?: SpanMark[] }>(
      HYGIENE_SYSTEM_PROMPT,
      `Transcript to clean:\n${text}`,
      4000,
      CLAUDE_BULK_MODEL
    )
    marks = Array.isArray(parsed.spans) ? parsed.spans : []
  } catch (err) {
    console.warn('[hygiene] pass failed; keeping full transcript:', err instanceof Error ? err.message : err)
    return { cleaned: text, removed: [] }
  }

  // Resolve each mark to a concrete [start, end) char range. Skip anything we
  // cannot locate unambiguously (keep-and-surface, never guess).
  const ranges: RemovedSpan[] = []
  for (const m of marks) {
    const startText = (m.start_text ?? '').trim()
    const endText = (m.end_text ?? '').trim()
    if (startText.length < ANCHOR_MIN) continue

    const start = text.indexOf(startText)
    if (start < 0) continue
    // A second occurrence means the anchor is ambiguous — keep, don't guess.
    if (text.indexOf(startText, start + 1) >= 0) continue

    let end: number
    if (endText.length >= ANCHOR_MIN) {
      const endAt = text.indexOf(endText, start)
      if (endAt < 0) continue
      end = endAt + endText.length
    } else {
      end = start + startText.length
    }
    if (end <= start) continue

    const kind = (['intro', 'outro', 'sponsor', 'ad'].includes(String(m.kind))
      ? m.kind
      : 'other') as RemovedSpan['kind']
    ranges.push({
      kind,
      reason: typeof m.reason === 'string' ? m.reason : '',
      preview: text.slice(start, Math.min(end, start + 160)),
      start,
      end,
    })
  }

  if (ranges.length === 0) return { cleaned: text, removed: [] }

  // Merge overlaps, then remove back-to-front so offsets stay valid.
  ranges.sort((a, b) => a.start - b.start)
  const merged: RemovedSpan[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end)
    } else {
      merged.push({ ...r })
    }
  }

  let cleaned = text
  for (let i = merged.length - 1; i >= 0; i--) {
    const { start, end } = merged[i]
    cleaned = cleaned.slice(0, start) + ' ' + cleaned.slice(end)
  }
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').trim()

  return { cleaned, removed: merged }
}
