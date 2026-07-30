import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { computeNovelty, type NoveltyRow } from "@/lib/novelty"

export const dynamic = "force-dynamic"

/**
 * NOVELTY — the dedup value, made visible (spec §9 / BACKLOG Stage 5.12).
 *
 * Read-only. For every ingested source it shows how much of what it said was
 * genuinely NEW knowledge vs. a REFINEMENT of something we already had vs.
 * flat-out REDUNDANT. Same computation as `npm run pipeline -- novelty`
 * (shared via lib/novelty.ts), so the workbench and the terminal agree.
 */

// Plain-English labels for a non-technical reader.
const LABELS = {
  novel: "New knowledge",
  refinement: "Reinforced what we already had",
  redundant: "Redundant",
} as const

// Segment colours for the split bar (kept legible in light + dark).
const BAR = {
  novel: "bg-emerald-500",
  refinement: "bg-sky-500",
  redundant: "bg-zinc-400 dark:bg-zinc-600",
} as const

function SplitBar({ row }: { row: NoveltyRow }) {
  // Widths come from raw counts, not the rounded percentages, so the bar always
  // fills exactly and never over/undershoots 100%.
  const segs = [
    { key: "novel", n: row.novel, cls: BAR.novel },
    { key: "refinement", n: row.refinement, cls: BAR.refinement },
    { key: "redundant", n: row.redundant, cls: BAR.redundant },
    // Not-yet-consolidated insights render as empty track, so they don't lie
    // about being "new". Rare in a settled corpus.
    { key: "unconsolidated", n: row.unconsolidated, cls: "bg-transparent" },
  ].filter((s) => s.n > 0)
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" title={`${row.total} facts`}>
      {segs.map((s) => (
        <div
          key={s.key}
          className={s.cls}
          style={{ width: `${(s.n / row.total) * 100}%` }}
        />
      ))}
    </div>
  )
}

export default async function NoveltyPage() {
  if (!supabaseAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <main>
          <div className="flex items-center justify-center min-h-[calc(100vh-4rem)]">
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-4">Configuration Required</h1>
              <p className="text-muted-foreground">
                Please set up your Supabase environment variables in .env.local
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY
              </p>
            </div>
          </div>
        </main>
      </div>
    )
  }

  let report = null
  let error: string | null = null
  try {
    report = await computeNovelty(supabaseAdmin)
  } catch (err) {
    console.error("Error computing novelty:", err)
    error = err instanceof Error ? err.message : "Unknown error"
  }

  const newest = report?.rows[0] ?? null
  const corpus = report?.corpus ?? null

  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-5xl mx-auto space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Novelty</h1>
                <p className="text-muted-foreground mt-1 max-w-2xl">
                  What each source actually <em>added</em> to the library. Every fact a source
                  states either breaks new ground, reinforces something we already had, or is
                  redundant — this is the deduplication engine&rsquo;s value, made visible.
                </p>
              </div>
              <Link href="/admin/sources">
                <Button variant="ghost" size="sm">← Sources</Button>
              </Link>
            </div>

            {error && (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-red-600 font-semibold mb-2">Error loading novelty report</p>
                  <p className="text-sm text-muted-foreground">{error}</p>
                </CardContent>
              </Card>
            )}

            {!error && newest && (
              <Card>
                <CardContent className="py-6">
                  <p className="text-2xl font-semibold tracking-tight">
                    {newest.novelPct}% of the newest source was new knowledge.
                  </p>
                  <p className="text-muted-foreground mt-1">
                    &ldquo;{newest.title}&rdquo; — {newest.novel} of {newest.total} facts broke
                    new ground; {newest.refinement} reinforced what we already had and{" "}
                    {newest.redundant} were redundant.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Legend */}
            {!error && report && (
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <span className="flex items-center gap-2">
                  <span className={`inline-block h-3 w-3 rounded-sm ${BAR.novel}`} />
                  {LABELS.novel}
                </span>
                <span className="flex items-center gap-2">
                  <span className={`inline-block h-3 w-3 rounded-sm ${BAR.refinement}`} />
                  {LABELS.refinement}
                </span>
                <span className="flex items-center gap-2">
                  <span className={`inline-block h-3 w-3 rounded-sm ${BAR.redundant}`} />
                  {LABELS.redundant}
                </span>
              </div>
            )}

            {!error && report && report.rows.length > 0 && (
              <Card>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Source</TableHead>
                          <TableHead className="text-right">Facts</TableHead>
                          <TableHead className="w-[220px]">Split</TableHead>
                          <TableHead className="text-right">{LABELS.novel}</TableHead>
                          <TableHead className="text-right">Reinforced</TableHead>
                          <TableHead className="text-right">Redundant</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {report.rows.map((row) => (
                          <TableRow key={row.sourceId}>
                            <TableCell className="font-medium max-w-[280px]">
                              <Link href={`/sources/${row.sourceId}`} className="hover:underline">
                                {row.title}
                              </Link>
                              {row.createdAt && (
                                <span className="block text-xs text-muted-foreground">
                                  {new Date(row.createdAt).toLocaleDateString("en-US", {
                                    month: "short",
                                    day: "numeric",
                                    year: "numeric",
                                  })}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{row.total}</TableCell>
                            <TableCell>
                              <SplitBar row={row} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                              {row.novelPct}%
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-sky-600 dark:text-sky-400">
                              {row.refinementPct}%
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {row.redundantPct}%
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}

            {!error && corpus && report && report.rows.length > 0 && (
              <Card>
                <CardContent className="py-5">
                  <div className="flex items-center justify-between gap-4 mb-2">
                    <span className="font-semibold">Whole library</span>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {corpus.total.toLocaleString()} facts across {report.rows.length} sources
                    </span>
                  </div>
                  <SplitBar
                    row={{
                      sourceId: "corpus",
                      title: "corpus",
                      createdAt: null,
                      total: corpus.total,
                      novel: corpus.novel,
                      refinement: corpus.refinement,
                      redundant: corpus.redundant,
                      unconsolidated: corpus.unconsolidated,
                      novelPct: corpus.novelPct,
                      refinementPct: corpus.refinementPct,
                      redundantPct: corpus.redundantPct,
                    }}
                  />
                  <p className="text-sm text-muted-foreground mt-3">
                    {corpus.novelPct}% genuinely new · {corpus.refinementPct}% reinforced ·{" "}
                    {corpus.redundantPct}% redundant. The reinforced + redundant share (
                    {corpus.refinementPct + corpus.redundantPct}%) is the deduplication work the
                    engine did so the library never stores the same fact twice.
                  </p>
                </CardContent>
              </Card>
            )}

            {!error && report && report.rows.length === 0 && (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-muted-foreground">
                    No consolidated facts yet. Ingest and extract a source to see its novelty.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
