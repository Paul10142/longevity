import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
// Committed eval data, bundled at build time (resolveJsonModule).
import pairsJson from "@/eval/extraction-eval-pairs.json"
import runJson from "@/eval/extraction-run.json"
import { pendingRechecks } from "@/lib/fidelity"
import { isHoldoutPairId } from "@/lib/judgeHoldout"

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
