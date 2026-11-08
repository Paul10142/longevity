import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
// Committed eval data, bundled at build time (resolveJsonModule).
import pairsJson from "@/eval/extraction-eval-pairs.json"
import runJson from "@/eval/extraction-run.json"
import { pendingRechecks } from "@/lib/fidelity"
import { isHoldoutPairId } from "@/lib/judgeHoldout"
import { buildExcerpt, excerptLink, sameEpisodeTitle, type Excerpt, type ExcerptLink } from "@/lib/fidelityExcerpt"
import type { SourceLinkInput } from "@/lib/sourceLinks"

export const dynamic = "force-dynamic"

type Pair = {
  id: string
  source_title: string
  statement: string
  context_note: string | null
  direct_quote: string | null
  quote_verified: boolean
  chunk_text: string
}
type Run = { id: string; verdict: string; offending: string; reasoning: string }

const VALID_LABELS = ["FAITHFUL", "ADDED_DETAIL", "DROPPED_QUALIFIER", "UNRESOLVED_REFERENCE"] as const

/**
 * GET  → the 40 fidelity pairs + the judge's take + any stored human label.
 *        ?export=goldset returns the eval/extraction-goldset.json shape that
 *        `evalExtraction.ts score` reads (judge verdict fills unlabeled pairs,
 *        marked unconfirmed — same convention as the old static worksheet).
 *        After the 40 static pairs come the hold-out pairs each overnight run sets aside
 *        (table fidelity_holdout, migration 033). The goldset export stays the 40 only.
 * POST → { pair_id, label } upserts a ruling; { pair_id, label: null } clears it.
 *        Re-posting the SAME label is how a re-check is confirmed: it bumps
 *        updated_at past JUDGE_COMPARED_AT (lib/fidelity.ts).
 */
type InsightRow = { id: string; statement: string; start_ms: number | null; chunk_id: string | null; source_id: string }
type SourceRow = SourceLinkInput & { id: string; timed_transcript: unknown; transcript: string | null }
type Extras = { excerpt: Excerpt | null; link: ExcerptLink | null }

/**
 * Read-only extras for each card: the transcript excerpt as speaker turns and the link
 * to the source. Any failure just means no extras: the card falls back to plain text.
 *   - original pairs: pair id `extract:<raw_insight id>`
 *   - hold-out pairs: pair id `holdout:<claim id>`; the member insight whose statement
 *     matches (else the claim's earliest member)
 */
async function loadExtras(
  db: NonNullable<typeof supabaseAdmin>,
  cards: { id: string; source: string; statement: string; quote: string | null; chunk: string }[]
): Promise<Map<string, Extras>> {
  const out = new Map<string, Extras>()
  try {
    const insightByPair = new Map<string, InsightRow>()
    const cols = "id, statement, start_ms, chunk_id, source_id"

    const insightIds = cards.filter(c => c.id.startsWith("extract:")).map(c => c.id.slice("extract:".length))
    if (insightIds.length) {
      const { data } = await db.from("raw_insights").select(cols).in("id", insightIds)
      for (const r of (data ?? []) as InsightRow[]) insightByPair.set(`extract:${r.id}`, r)
    }

    const claimIds = cards.filter(c => isHoldoutPairId(c.id)).map(c => c.id.slice("holdout:".length))
    if (claimIds.length) {
      const { data } = await db
        .from("claim_members")
        .select(`claim_id, raw_insights(${cols}, created_at)`)
        .in("claim_id", claimIds)
      const byClaim = new Map<string, (InsightRow & { created_at: string })[]>()
      for (const m of (data ?? []) as unknown as { claim_id: string; raw_insights: (InsightRow & { created_at: string }) | null }[]) {
        if (!m.raw_insights) continue
        byClaim.set(m.claim_id, [...(byClaim.get(m.claim_id) ?? []), m.raw_insights])
      }
      for (const c of cards.filter(c => isHoldoutPairId(c.id))) {
        const members = (byClaim.get(c.id.slice("holdout:".length)) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at))
        const pick = members.find(m => m.statement.trim() === c.statement.trim()) ?? members[0]
        if (pick) insightByPair.set(c.id, pick)
      }
    }

    // Source rows: by the insight's source id; where the insight no longer exists (the
    // episode was re-extracted), by the episode title the pair was filed under.
    const sourceCols = "id, title, series, episode_number, youtube_url, url, article_url, external_id, timed_transcript, transcript"
    const sourceIds = [...new Set([...insightByPair.values()].map(r => r.source_id))]
    const sources = new Map<string, SourceRow>()
    const sourceByTitle = new Map<string, SourceRow | null>()
    const titles = [...new Set(cards.filter(c => !insightByPair.has(c.id)).map(c => c.source.replace(/^New batch: /, "")))]
    await Promise.all([
      ...sourceIds.map(async id => {
        const { data } = await db.from("sources").select(sourceCols).eq("id", id).maybeSingle()
        if (data) sources.set(id, data as unknown as SourceRow)
      }),
      ...titles.map(async title => {
        // The title a pair was filed under can be cut short, end in "|" or use another dash,
        // so look up by its opening characters and compare normalized.
        const lead = title.split(/\s*[‒–—−-]/)[0].trim()
        const prefix = (lead.length >= 3 ? lead : title.slice(0, 14)).replace(/[%_,()\\]/g, "_")
        const { data: cands } = await db.from("sources").select("id, title").ilike("title", `${prefix}%`).limit(60)
        const hit = ((cands ?? []) as { id: string; title: string | null }[]).find(c => sameEpisodeTitle(title, c.title))
        if (!hit) return void sourceByTitle.set(title, null)
        const { data } = await db.from("sources").select(sourceCols).eq("id", hit.id).maybeSingle()
        sourceByTitle.set(title, (data as unknown as SourceRow | null) ?? null)
      }),
    ])

    for (const c of cards) {
      const insight = insightByPair.get(c.id)
      const source = insight
        ? sources.get(insight.source_id) ?? null
        : sourceByTitle.get(c.source.replace(/^New batch: /, "")) ?? null
      const excerpt = buildExcerpt(c.chunk, source?.timed_transcript, source?.transcript, c.quote)
      // Time of the quote: where the quote itself sits in the stored transcript, else the
      // insight's own stored time, else where the passage the judge read starts.
      const startMs =
        excerpt?.startFrom === "quote" ? excerpt.startMs : insight?.start_ms ?? excerpt?.startMs ?? null
      out.set(c.id, { excerpt, link: excerptLink(source, startMs) })
    }
  } catch {
    // extras are a convenience; the 50 cards must still load
  }
  return out
}

export async function GET(request: NextRequest) {
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })

  const pairs = pairsJson as Pair[]
  const runById = new Map((runJson as Run[]).map(r => [r.id, r]))

  type LabelRow = {
    pair_id: string
    label: string
    labeled_by: string
    rationale: string | null
    updated_at: string | null
  }
  const { data: labelRows, error } = await supabaseAdmin
    .from("fidelity_labels")
    .select("pair_id, label, labeled_by, rationale, updated_at")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const labelById = new Map(((labelRows ?? []) as LabelRow[]).map(l => [l.pair_id, l]))

  if (request.nextUrl.searchParams.get("export") === "goldset") {
    const goldset = pairs.map(p => {
      const human = labelById.get(p.id)
      const judge = runById.get(p.id)
      return {
        id: p.id,
        label: human?.label ?? judge?.verdict ?? "FAITHFUL",
        confirmed: human?.labeled_by === "paul",
        labeled_by: human ? human.labeled_by : "claude-proposed",
        rationale: human?.rationale ?? "",
      }
    })
    return NextResponse.json(goldset)
  }

  // Hold-out pairs from overnight runs. A missing table (migration 033 not applied yet)
  // just means none: the 40 original pairs must keep working.
  type HoldoutRow = {
    pair_id: string; source_title: string; statement: string; context_note: string | null
    direct_quote: string | null; quote_verified: boolean; chunk_text: string
    judge_verdict: string; judge_offending: string; judge_reasoning: string
  }
  const { data: holdoutData } = await supabaseAdmin
    .from("fidelity_holdout")
    .select("pair_id, source_title, statement, context_note, direct_quote, quote_verified, chunk_text, judge_verdict, judge_offending, judge_reasoning")
    .order("created_at", { ascending: true })
    .order("pair_id", { ascending: true })
  const holdout = (holdoutData ?? []) as HoldoutRow[]

  const recheck = pendingRechecks(
    (labelRows ?? []) as LabelRow[],
    new Map([...runById].map(([id, r]) => [id, r.verdict]))
  )

  const extras = await loadExtras(supabaseAdmin, [
    ...pairs.map(p => ({ id: p.id, source: p.source_title, statement: p.statement, quote: p.direct_quote, chunk: p.chunk_text })),
    ...holdout.map(h => ({ id: h.pair_id, source: h.source_title, statement: h.statement, quote: h.direct_quote, chunk: h.chunk_text })),
  ])

  const items = pairs.map((p, i) => {
    const judge = runById.get(p.id)
    const human = labelById.get(p.id)
    return {
      n: i + 1,
      id: p.id,
      source: p.source_title,
      statement: p.statement,
      context: p.context_note,
      quote: p.direct_quote,
      quote_verified: p.quote_verified,
      chunk: p.chunk_text,
      judge_verdict: judge?.verdict ?? "UNSURE",
      judge_offending: judge?.offending ?? "",
      judge_reasoning: judge?.reasoning ?? "",
      label: human?.label ?? null,
      needs_recheck: recheck.has(p.id),
      excerpt: extras.get(p.id)?.excerpt ?? null,
      excerpt_link: extras.get(p.id)?.link ?? null,
    }
  })
  const holdoutItems = holdout.map((h, i) => ({
    n: items.length + i + 1,
    id: h.pair_id,
    source: `New batch: ${h.source_title}`,
    statement: h.statement,
    context: h.context_note,
    quote: h.direct_quote,
    quote_verified: h.quote_verified,
    chunk: h.chunk_text,
    judge_verdict: h.judge_verdict,
    judge_offending: h.judge_offending,
    judge_reasoning: h.judge_reasoning,
    label: labelById.get(h.pair_id)?.label ?? null,
    needs_recheck: false,
    excerpt: extras.get(h.pair_id)?.excerpt ?? null,
    excerpt_link: extras.get(h.pair_id)?.link ?? null,
  }))
  return NextResponse.json({ items: [...items, ...holdoutItems] })
}

export async function POST(request: NextRequest) {
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })

  const body = (await request.json()) as { pair_id?: string; label?: string | null }
  const pairId = body.pair_id
  let known = !!pairId && (pairsJson as Pair[]).some(p => p.id === pairId)
  if (!known && pairId && isHoldoutPairId(pairId)) {
    const { data } = await supabaseAdmin.from("fidelity_holdout").select("pair_id").eq("pair_id", pairId).maybeSingle()
    known = !!data
  }
  if (!pairId || !known) {
    return NextResponse.json({ error: "Unknown pair_id" }, { status: 400 })
  }

  if (body.label === null) {
    const { error } = await supabaseAdmin.from("fidelity_labels").delete().eq("pair_id", pairId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, cleared: true })
  }

  if (!VALID_LABELS.includes(body.label as (typeof VALID_LABELS)[number])) {
    return NextResponse.json({ error: `label must be one of ${VALID_LABELS.join(", ")}` }, { status: 400 })
  }

  const { error } = await supabaseAdmin.from("fidelity_labels").upsert(
    { pair_id: pairId, label: body.label, labeled_by: "paul", updated_at: new Date().toISOString() },
    { onConflict: "pair_id" }
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
