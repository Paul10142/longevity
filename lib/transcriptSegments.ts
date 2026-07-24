/**
 * Timed-transcript helpers (Phase 1 timestamp demonstration).
 *
 * The YouTube Transcript API returns each caption as `{ text, start, duration }`
 * in SECONDS. We normalise those to `{ text, start_ms, end_ms }` and persist the
 * array on `sources.timed_transcript` (migration 010). At extraction time we map
 * each transcript chunk back onto the segments it spans, so a chunk — and every
 * raw_insight extracted from it — can carry `start_ms`/`end_ms` and the reader
 * can deep-link to the exact moment in the video.
 *
 * Sources without timing (the four manual-paste seed transcripts) have no
 * segments; every function here degrades to "no timing" (null) for them.
 */

export type TimedSegment = {
  text: string
  start_ms: number
  end_ms: number
}

export type ChunkTiming = { start_ms: number; end_ms: number }

/**
 * Locate the raw timed-segment array inside a youtube-transcript.io video object.
 * The API's real shape (verified 2026-07-23) is
 *   { text: "<flat transcript>", tracks: [{ language, transcript: [{start,dur,text}, …] }] }
 * — the timed captions live at `tracks[0].transcript` with start/dur as STRING
 * seconds, NOT at a top-level `transcript` field. We still accept the older
 * `transcript` / `text`-array shapes as fallbacks so a format change can't
 * silently drop timing. Returns `[]` when no per-caption array is present.
 */
export function extractApiSegments(videoData: unknown): unknown[] {
  if (!videoData || typeof videoData !== 'object') return []
  const v = videoData as Record<string, unknown>
  const tracks = v.tracks
  if (Array.isArray(tracks) && tracks.length > 0) {
    const t0 = tracks[0] as Record<string, unknown> | undefined
    if (t0 && Array.isArray(t0.transcript)) return t0.transcript
  }
  if (Array.isArray(v.transcript)) return v.transcript
  if (Array.isArray(v.text)) return v.text
  return []
}

/**
 * Normalise raw YouTube-Transcript-API segments to `TimedSegment`s.
 * Input segments look like `{ text, start, dur|duration }` with start/duration in
 * seconds — the API emits them as numeric-strings ("0.48"), so we coerce. `dur`
 * is the live field name; `duration` is accepted as an alias. Tolerant of missing
 * fields; skips segments without usable text or a numeric start.
 */
export function normalizeYouTubeSegments(raw: unknown): TimedSegment[] {
  if (!Array.isArray(raw)) return []
  const out: TimedSegment[] = []
  for (const seg of raw) {
    if (!seg || typeof seg !== 'object') continue
    const s = seg as Record<string, unknown>
    const text = typeof s.text === 'string' ? s.text.trim() : ''
    if (!text) continue
    // Idempotent: `sources.timed_transcript` stores segments ALREADY normalised
    // to { text, start_ms, end_ms }. Extraction re-runs this function on that
    // stored array, so pass a normalised segment straight through rather than
    // re-deriving from a non-existent `start`/`dur` (which silently drops it).
    const preMs = Number(s.start_ms)
    if (Number.isFinite(preMs)) {
      const preEnd = Number(s.end_ms)
      const start_ms = Math.max(0, Math.round(preMs))
      out.push({ text, start_ms, end_ms: Number.isFinite(preEnd) ? Math.max(start_ms, Math.round(preEnd)) : start_ms })
      continue
    }
    const start = Number(s.start)
    if (!Number.isFinite(start)) continue
    const duration = Number(s.duration ?? s.dur)
    const start_ms = Math.max(0, Math.round(start * 1000))
    const end_ms = Number.isFinite(duration)
      ? start_ms + Math.max(0, Math.round(duration * 1000))
      : start_ms
    out.push({ text, start_ms, end_ms })
  }
  return out
}

/**
 * The canonical flat transcript we chunk and store, rebuilt from segments.
 * Must match the join the fetch routes use (single space) so char offsets line
 * up with the segment offset index built in `computeChunkTimings`.
 */
export function buildTranscriptFromSegments(segments: TimedSegment[]): string {
  return segments.map(s => s.text).join(' ').trim()
}

/**
 * Map each chunk to the timing of the segments it spans.
 *
 * Chunks are produced (by `splitIntoChunks`) in document order from the same
 * text the segments join to, so we scan the joined transcript with a monotonic
 * cursor: for each chunk we locate a short anchor from its start and its end,
 * take the char span between them, and collect every segment overlapping that
 * span. `start_ms` = earliest overlapped segment; `end_ms` = latest.
 *
 * Robust to transcript hygiene having removed spans before chunking: we anchor
 * on surviving text (which still appears in the joined transcript), so a chunk
 * that straddles a removed ad still maps to the right surrounding segments. When
 * a chunk cannot be located (e.g. its text was rewritten), that chunk gets
 * `null` — timing is best-effort, never wrong-effort.
 */
export function computeChunkTimings(
  chunks: string[],
  segments: TimedSegment[]
): (ChunkTiming | null)[] {
  if (segments.length === 0) return chunks.map(() => null)

  // Build the joined transcript and a parallel per-segment char-offset index.
  const offsets: { start: number; end: number; seg: TimedSegment }[] = []
  let pos = 0
  let joined = ''
  for (let i = 0; i < segments.length; i++) {
    const t = segments[i].text
    if (i > 0) { joined += ' '; pos += 1 }
    const start = pos
    joined += t
    pos += t.length
    offsets.push({ start, end: pos, seg: segments[i] })
  }

  const ANCHOR = 40
  const anchorOf = (s: string, fromEnd: boolean) => {
    const trimmed = s.trim()
    return fromEnd ? trimmed.slice(-ANCHOR) : trimmed.slice(0, ANCHOR)
  }

  // Given a char span, find the min start_ms / max end_ms over overlapping segs.
  const timingForSpan = (spanStart: number, spanEnd: number): ChunkTiming | null => {
    let start_ms = Infinity
    let end_ms = -Infinity
    for (const o of offsets) {
      if (o.end <= spanStart) continue
      if (o.start >= spanEnd) break
      start_ms = Math.min(start_ms, o.seg.start_ms)
      end_ms = Math.max(end_ms, o.seg.end_ms)
    }
    if (start_ms === Infinity) return null
    return { start_ms, end_ms }
  }

  let cursor = 0
  return chunks.map(chunk => {
    const startAnchor = anchorOf(chunk, false)
    const endAnchor = anchorOf(chunk, true)
    let spanStart = startAnchor ? joined.indexOf(startAnchor, cursor) : -1
    // Fall back to a global search if the monotonic cursor overshot.
    if (spanStart < 0 && startAnchor) spanStart = joined.indexOf(startAnchor)
    if (spanStart < 0) return null

    let spanEnd = endAnchor ? joined.indexOf(endAnchor, spanStart) : -1
    spanEnd = spanEnd < 0 ? spanStart + chunk.trim().length : spanEnd + endAnchor.length
    cursor = Math.max(cursor, spanStart + 1)
    return timingForSpan(spanStart, spanEnd)
  })
}
