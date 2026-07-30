import { selectAllPaged } from "@/lib/pagination"

/**
 * Per-source NOVELTY computation (spec §9): the engine's dedup value, made
 * visible. This is the ONE implementation shared by the admin API route
 * (app/api/admin/novelty/route.ts), the admin page, and it mirrors the
 * `novelty` case in scripts/pipeline.ts so the workbench and the terminal
 * agree. Do not fork the classification — change it here.
 *
 * Per source, classify each of its raw_insights into three buckets:
 *   redundant  — merged into a claim it did not seed (matched_by !== 'seed');
 *                added nothing new
 *   refinement — seeded a claim that is near_duplicate-linked to existing
 *                material (a new dose/population/caveat on a known idea — the
 *                engine's REAL value, counted as partially redundant)
 *   novel      — seeded a claim with no such link (genuinely new ground)
 * Plus `unconsolidated` — an insight not yet folded into any claim.
 *
 * The headline "% new" is the novel bucket; the dedup story is refinement +
 * redundant. Read-only, no LLM, no writes.
 */

export type NoveltyRow = {
  sourceId: string
  title: string
  createdAt: string | null
  total: number
  novel: number
  refinement: number
  redundant: number
  unconsolidated: number
  novelPct: number
  refinementPct: number
  redundantPct: number
}

export type NoveltyCorpus = {
  total: number
  novel: number
  refinement: number
  redundant: number
  unconsolidated: number
  novelPct: number
  refinementPct: number
  redundantPct: number
}

export type NoveltyReport = {
  rows: NoveltyRow[]
  corpus: NoveltyCorpus
}

type Bucket = { redundant: number; refinement: number; novel: number; unconsolidated: number }

/** Minimal shape of the supabase client we depend on — keeps this module free
 *  of the supabase-js generic types while matching `supabaseAdmin`. */
type Db = {
  from: (table: string) => any
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0)

export async function computeNovelty(db: Db): Promise<NoveltyReport> {
  // Every read whose size grows with the corpus is paged (raw_insights,
  // claim_members, claim_links). `sources` is small and bounded.
  const [insRows, memRows, linkRows, srcRes] = await Promise.all([
    selectAllPaged<{ id: string; source_id: string }>((f, t) =>
      db
        .from("raw_insights")
        .select("id, source_id")
        .order("created_at", { ascending: true })
        .range(f, t)
    ),
    selectAllPaged<{ raw_insight_id: string; claim_id: string; matched_by: string }>((f, t) =>
      db
        .from("claim_members")
        .select("raw_insight_id, claim_id, matched_by")
        .order("created_at", { ascending: true })
        .range(f, t)
    ),
    selectAllPaged<{ claim_id: string; related_claim_id: string }>((f, t) =>
      db
        .from("claim_links")
        .select("claim_id, related_claim_id")
        .eq("kind", "near_duplicate")
        .order("claim_id", { ascending: true })
        .range(f, t)
    ),
    db.from("sources").select("id, title, created_at").order("created_at", { ascending: false }),
  ])

  if (srcRes.error) throw new Error(`Failed to load sources: ${srcRes.error.message}`)

  const srcRows = (srcRes.data ?? []) as { id: string; title: string; created_at: string | null }[]
  const memByInsight = new Map(memRows.map((m) => [m.raw_insight_id, m]))
  const linkedClaims = new Set<string>()
  for (const l of linkRows) {
    linkedClaims.add(l.claim_id)
    linkedClaims.add(l.related_claim_id)
  }

  const bySource = new Map<string, Bucket>()
  for (const ins of insRows) {
    const b =
      bySource.get(ins.source_id) ?? { redundant: 0, refinement: 0, novel: 0, unconsolidated: 0 }
    const m = memByInsight.get(ins.id)
    if (!m) b.unconsolidated++ // not yet consolidated into any claim
    else if (m.matched_by !== "seed") b.redundant++ // merged into an existing claim
    else if (linkedClaims.has(m.claim_id)) b.refinement++ // seeded, but a variant of known material
    else b.novel++ // seeded new ground
    bySource.set(ins.source_id, b)
  }

  const corpus: Bucket = { redundant: 0, refinement: 0, novel: 0, unconsolidated: 0 }
  const rows: NoveltyRow[] = []
  // srcRows are already newest-first; keep that order for the table.
  for (const s of srcRows) {
    const b = bySource.get(s.id) ?? { redundant: 0, refinement: 0, novel: 0, unconsolidated: 0 }
    const total = b.redundant + b.refinement + b.novel + b.unconsolidated
    if (total === 0) continue // sources with nothing extracted yet add no signal
    corpus.redundant += b.redundant
    corpus.refinement += b.refinement
    corpus.novel += b.novel
    corpus.unconsolidated += b.unconsolidated
    rows.push({
      sourceId: s.id,
      title: s.title,
      createdAt: s.created_at,
      total,
      novel: b.novel,
      refinement: b.refinement,
      redundant: b.redundant,
      unconsolidated: b.unconsolidated,
      novelPct: pct(b.novel, total),
      refinementPct: pct(b.refinement, total),
      redundantPct: pct(b.redundant, total),
    })
  }

  const grand = corpus.redundant + corpus.refinement + corpus.novel + corpus.unconsolidated

  return {
    rows,
    corpus: {
      total: grand,
      novel: corpus.novel,
      refinement: corpus.refinement,
      redundant: corpus.redundant,
      unconsolidated: corpus.unconsolidated,
      novelPct: pct(corpus.novel, grand),
      refinementPct: pct(corpus.refinement, grand),
      redundantPct: pct(corpus.redundant, grand),
    },
  }
}
