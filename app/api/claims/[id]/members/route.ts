import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { isAdmin } from "@/lib/isAdmin"
import { episodeLinks, publicVideoUrl, type EpisodeLink } from "@/lib/sourceLinks"

export const dynamic = "force-dynamic"

/**
 * The provenance drill-down for one claim: every raw insight that supports it
 * (with its verbatim quote, source, and locator), plus the verified third-party
 * references linked to it. The leaf of the chain
 * article paragraph → claim → raw insight → source (+ verified reference).
 *
 * Each member's `source` carries PUBLIC links only (`links`, `video_url`),
 * resolved by lib/sourceLinks. `sources.url` is read but never returned: for
 * podcast rows it is the private, members-only Supercast feed link.
 */

type SourceRow = {
  id: string
  title: string
  type: string
  url: string | null
  youtube_url: string | null
  article_url: string | null
  episode_number: number | null
}

export type MemberSource = {
  id: string
  title: string
  type: string
  links: EpisodeLink[]
  video_url: string | null
}

function publicSource(s: SourceRow | null): MemberSource | null {
  if (!s) return null
  return { id: s.id, title: s.title, type: s.type, links: episodeLinks(s), video_url: publicVideoUrl(s) }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  const { id } = await params

  const [{ data: memberData, error }, { data: refLinks }] = await Promise.all([
    supabaseAdmin
      .from("claim_members")
      .select(
        `raw_insight_id, matched_by,
         raw_insights (
           statement, direct_quote, locator, start_ms, end_ms, evidence_type, confidence,
           sources ( id, title, type, url, youtube_url, article_url, episode_number )
         )`
      )
      .eq("claim_id", id),
    supabaseAdmin.from("claim_references").select("reference_id").eq("claim_id", id),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const members = (memberData ?? []).map((m: {
    raw_insight_id: string
    matched_by: string
    raw_insights: {
      statement: string; direct_quote: string | null; locator: string
      start_ms: number | null; end_ms: number | null; evidence_type: string; confidence: string
      sources: SourceRow | null
    } | null
  }) => ({
    raw_insight_id: m.raw_insight_id,
    matched_by: m.matched_by,
    statement: m.raw_insights?.statement,
    direct_quote: m.raw_insights?.direct_quote ?? null,
    locator: m.raw_insights?.locator,
    start_ms: m.raw_insights?.start_ms ?? null,
    evidence_type: m.raw_insights?.evidence_type,
    confidence: m.raw_insights?.confidence,
    source: publicSource(m.raw_insights?.sources ?? null),
  }))

  // Verified references supporting this claim.
  let references: { id: string; title: string; authors: string[] | null; year: number | null; journal: string | null; url: string | null }[] = []
  const refIds = (refLinks ?? []).map((r: { reference_id: string }) => r.reference_id)
  if (refIds.length > 0) {
    const { data: refs } = await supabaseAdmin
      .from("references_")
      .select("id, title, authors, year, journal, doi, url")
      .in("id", refIds)
      .order("year", { ascending: false, nullsFirst: false })
    references = (refs ?? []).map((r: { id: string; title: string; authors: string[] | null; year: number | null; journal: string | null; doi: string | null; url: string | null }) => ({
      id: r.id, title: r.title, authors: r.authors, year: r.year, journal: r.journal,
      url: r.url ?? (r.doi ? `https://doi.org/${r.doi}` : null),
    }))
  }

  return NextResponse.json({ members, references })
}
