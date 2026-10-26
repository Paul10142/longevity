/**
 * Pure helpers for the Ask the Library UI: no React, no I/O, so they are
 * tested directly in tests/askLib.test.ts.
 *
 *  - marker parsing: `[3]` in the model's prose becomes a citation chip
 *  - the NDJSON line reader for the /api/ask stream
 *  - the stream-event reducer
 *  - "Go deeper" episode ranking and related-page grouping
 */
import type {
  AskEvent,
  AskState,
  ClaimMember,
  Cited,
  Episode,
  MembersState,
  StoredAnswer,
  TopicLink,
} from "./types"

// ── Citation markers ───────────────────────────────────────────────────────

/** `[3]` or `[3, 5]`, but not `[3](url)` (a real markdown link). */
const MARKER_RE = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g

/** Anchor prefix the markdown renderer turns into a chip. */
export const CITE_PREFIX = "#cite-"

export function citeHref(n: number): string {
  return `${CITE_PREFIX}${n}`
}

/** The citation number a chip anchor points at, or null for any other link. */
export function citeNumber(href: string | undefined | null): number | null {
  if (!href || !href.startsWith(CITE_PREFIX)) return null
  const n = Number(href.slice(CITE_PREFIX.length))
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Every marker number in the text, in order of appearance (repeats kept). */
export function extractMarkers(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(MARKER_RE)) {
    for (const part of m[1].split(",")) out.push(Number(part.trim()))
  }
  return out
}

/**
 * Rewrite markers as markdown links to `#cite-n` so the renderer can swap them
 * for chips: `a claim [3]` → `a claim [3](#cite-3)`, `[3, 5]` → two chips.
 */
export function markersToLinks(text: string): string {
  return text.replace(MARKER_RE, (_all, nums: string) =>
    nums
      .split(",")
      .map((p) => Number(p.trim()))
      .map((n) => `[${n}](${citeHref(n)})`)
      .join("")
  )
}

/**
 * While the answer streams, a marker can arrive in pieces (`[`, `[1`, `[1,`).
 * Hide that unfinished tail so a half-typed marker never flashes as text.
 */
export function hideTrailingPartialMarker(text: string): string {
  return text.replace(/\[(?:\d{1,3}(?:\s*,\s*\d{0,3})*)?\s*$/, "")
}

/** Text of the answer ready for the markdown renderer. */
export function prepareBody(body: string, streaming: boolean): string {
  return markersToLinks(streaming ? hideTrailingPartialMarker(body) : body)
}

// ── NDJSON stream ──────────────────────────────────────────────────────────

/**
 * Splits streamed text into lines and hands each complete JSON line to
 * `onEvent`. Chunks can end mid-line; the tail is held until its newline
 * arrives (or `flush`). Lines that are not valid JSON are skipped.
 */
export function createLineParser(onEvent: (event: AskEvent) => void) {
  let buffer = ""
  const emit = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        onEvent(parsed as AskEvent)
      }
    } catch {
      // A malformed line must not kill the stream.
    }
  }
  return {
    push(chunk: string) {
      buffer += chunk
      let at = buffer.indexOf("\n")
      while (at !== -1) {
        emit(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        at = buffer.indexOf("\n")
      }
    },
    flush() {
      emit(buffer)
      buffer = ""
    },
  }
}

/** Read a fetch body to the end, calling `onEvent` per NDJSON line. */
export async function readNdjson(body: ReadableStream<Uint8Array>, onEvent: (event: AskEvent) => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createLineParser(onEvent)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parser.push(decoder.decode(value, { stream: true }))
  }
  parser.push(decoder.decode())
  parser.flush()
}

// ── State ──────────────────────────────────────────────────────────────────

export const initialAskState: AskState = {
  phase: "idle",
  question: "",
  body: "",
  thin: false,
  retrievalCount: null,
  cached: false,
  answeredAt: null,
  answerId: null,
  cited: [],
  followUps: [],
  relatedTopics: [],
  nearestTopics: [],
  latencyMs: null,
  error: null,
}

export type AskAction = AskEvent | { type: "start"; question: string } | { type: "loaded"; answer: StoredAnswer } | { type: "reset" }

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case "reset":
      return initialAskState
    case "start":
      return { ...initialAskState, phase: "retrieving", question: action.question }
    case "retrieval":
      return {
        ...state,
        phase: "streaming",
        retrievalCount: action.count,
        thin: action.thin,
        cached: action.cached ?? state.cached,
        answeredAt: action.answered_at ?? state.answeredAt,
      }
    case "delta":
      // Cached answers send the whole body in one delta; live ones send many.
      return { ...state, phase: state.phase === "retrieving" ? "streaming" : state.phase, body: state.body + action.text }
    case "done":
      return {
        ...state,
        phase: "done",
        answerId: action.answer_id,
        cited: action.cited ?? [],
        followUps: action.follow_ups ?? [],
        relatedTopics: action.related_topics ?? state.relatedTopics,
        latencyMs: action.latency_ms ?? null,
        cached: action.cached ?? state.cached,
        answeredAt: action.answered_at ?? state.answeredAt,
      }
    case "not_covered":
      return { ...state, phase: "not_covered", nearestTopics: action.nearest_topics ?? [] }
    case "error":
      return { ...state, phase: "error", error: action.message }
    case "loaded": {
      const a = action.answer
      const phase = a.status === "not_covered" ? "not_covered" : a.status === "failed" ? "error" : "done"
      return {
        ...initialAskState,
        phase,
        question: a.question,
        body: a.body,
        answerId: a.id,
        cited: a.cited,
        followUps: a.followUps,
        relatedTopics: a.relatedTopics,
        nearestTopics: a.nearestTopics,
        cached: true,
        answeredAt: a.createdAt,
        error: phase === "error" ? "This answer could not be completed." : null,
      }
    }
  }
}

// ── Stored answers ─────────────────────────────────────────────────────────

function asTopics(value: unknown): TopicLink[] {
  if (!Array.isArray(value)) return []
  const out: TopicLink[] = []
  for (const t of value) {
    if (!t || typeof t !== "object") continue
    const o = t as Record<string, unknown>
    const name = typeof o.name === "string" ? o.name : typeof o.title === "string" ? o.title : null
    const slug = typeof o.slug === "string" ? o.slug : null
    if (name && slug) out.push({ name, slug })
  }
  return out
}

/**
 * GET /api/ask/[id] returns "the stored answer" (design §6.7). Accept either
 * the table-row shape (`body_markdown`, `cited_claim_ids`) or the event shape
 * (`cited: [{n, claim_id}]`), bare or wrapped as `{ answer }`.
 */
export function normalizeStored(json: unknown): StoredAnswer | null {
  if (!json || typeof json !== "object") return null
  const root = json as Record<string, unknown>
  const a = (root.answer && typeof root.answer === "object" ? root.answer : root) as Record<string, unknown>
  if (typeof a.id !== "string" || typeof a.question !== "string") return null

  let cited: Cited[] = []
  if (Array.isArray(a.cited)) {
    cited = (a.cited as Record<string, unknown>[])
      .filter((c) => c && typeof c.n === "number" && typeof c.claim_id === "string")
      .map((c) => ({
        n: c.n as number,
        claim_id: c.claim_id as string,
        statement: typeof c.statement === "string" ? c.statement : null,
      }))
  } else if (Array.isArray(a.cited_claim_ids)) {
    cited = (a.cited_claim_ids as unknown[])
      .filter((id): id is string => typeof id === "string")
      .map((claim_id, i) => ({ n: i + 1, claim_id }))
  }

  const status = a.status === "not_covered" || a.status === "failed" ? a.status : "answered"
  return {
    id: a.id,
    question: a.question,
    status,
    body: typeof a.body_markdown === "string" ? a.body_markdown : typeof a.body === "string" ? a.body : "",
    cited,
    followUps: Array.isArray(a.follow_ups) ? (a.follow_ups as unknown[]).filter((f): f is string => typeof f === "string") : [],
    relatedTopics: asTopics(a.related_topics),
    nearestTopics: asTopics(a.nearest_topics),
    createdAt: typeof a.created_at === "string" ? a.created_at : null,
  }
}

// ── Evidence and "Go deeper" ───────────────────────────────────────────────

/** `YYYY-MM-DD` or a full ISO timestamp → "Mar 4, 2024". Null when unparseable. */
export function formatDate(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
}

/** `MetaAnalysis` / `expert_opinion` → "Meta Analysis" / "Expert Opinion". */
export function prettyLabel(value: string | null | undefined): string {
  if (!value) return ""
  return value
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** The source date for a member, wherever the backend puts it. */
export function memberDate(m: ClaimMember): string | null {
  return m.source?.date ?? m.date ?? null
}

/**
 * Members worth showing first: those with a verbatim quote, then those we can
 * link to a moment in the video. Stable otherwise.
 */
export function sortMembers(members: ClaimMember[]): ClaimMember[] {
  const score = (m: ClaimMember) =>
    (m.direct_quote ? 2 : 0) + (m.source?.video_url && m.start_ms != null ? 1 : 0)
  return members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => score(b.m) - score(a.m) || a.i - b.i)
    .map((x) => x.m)
}

/**
 * Episodes behind the answer, most-cited first. An episode's count is the
 * number of different citations it supports. `href` is the first public link
 * the members payload gave for the episode (never a private feed URL: the
 * payload only carries public links, and the caller re-checks).
 */
export function rankEpisodes(cited: Cited[], membersByClaim: Record<string, MembersState | undefined>): Episode[] {
  const byId = new Map<string, Episode & { ns: Set<number> }>()
  for (const c of cited) {
    const state = membersByClaim[c.claim_id]
    if (!state || state.status !== "ok") continue
    for (const m of state.members) {
      if (!m.source) continue
      const existing = byId.get(m.source.id)
      const date = memberDate(m)
      if (existing) {
        existing.ns.add(c.n)
        if (!existing.date && date) existing.date = date
      } else {
        byId.set(m.source.id, {
          id: m.source.id,
          title: m.source.title,
          date,
          href: m.source.links?.[0]?.href ?? m.source.video_url ?? null,
          citations: 0,
          ns: new Set([c.n]),
        })
      }
    }
  }
  return [...byId.values()]
    .map(({ ns, ...e }) => ({ ...e, citations: ns.size }))
    .sort((a, b) => b.citations - a.citations || (b.date ?? "").localeCompare(a.date ?? "") || a.title.localeCompare(b.title))
}

/**
 * Related pages when the stream does not name them: group the topic tags on
 * the semantic-search hits (`POST /api/search`) and keep the most frequent.
 */
export function relatedFromSearch(
  results: { topic: { name: string; slug: string } | null }[],
  limit = 4
): TopicLink[] {
  const counts = new Map<string, { topic: TopicLink; n: number; first: number }>()
  results.forEach((r, i) => {
    if (!r.topic) return
    const hit = counts.get(r.topic.slug)
    if (hit) hit.n += 1
    else counts.set(r.topic.slug, { topic: { name: r.topic.name, slug: r.topic.slug }, n: 1, first: i })
  })
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.first - b.first)
    .slice(0, limit)
    .map((x) => x.topic)
}
