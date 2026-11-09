import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { selectAllPaged } from "@/lib/pagination"

/**
 * Skipped episodes (migration 038): re-posts, rebroadcasts, "Essentials" cuts,
 * Huberman AMA / live Q&A items and copies of an episode the library already
 * holds. They stay in the table so the
 * feed never re-creates them, but no picker transcribes or extracts them.
 *
 * Read-only. Each row says why it was skipped and links to the copy that is kept.
 * "Facts" counts what was already extracted from the skipped copy before it was
 * skipped; those facts stay in the claims until a person approves retiring them
 * (scripts/dedupLibrary.ts prints the list).
 */
export const dynamic = "force-dynamic"

type SkippedRow = {
  id: string
  title: string | null
  series: string | null
  date: string | null
  created_at: string | null
  skip_reason: string | null
  duplicate_of: string | null
  last_processed_at: string | null
}

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export default async function AdminDuplicatesPage() {
  if (!supabaseAdmin) {
    return (
      <div className="container mx-auto px-4 py-12">
        <h1 className="text-2xl font-bold">Configuration Required</h1>
        <p className="text-muted-foreground mt-2">Supabase environment variables are not set.</p>
      </div>
    )
  }
  const db = supabaseAdmin

  let rows: SkippedRow[] = []
  let loadError: string | null = null
  try {
    rows = await selectAllPaged<SkippedRow>((from, to) =>
      db
        .from("sources")
        .select("id, title, series, date, created_at, skip_reason, duplicate_of, last_processed_at")
        .eq("processing_status", "skipped")
        .order("series")
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)
    )
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
  }

  if (loadError) {
    const notApplied = /skip_reason|duplicate_of|column/i.test(loadError)
    return (
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-4xl font-bold mb-6">Skipped Episodes</h1>
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-destructive font-semibold mb-2">
                {notApplied ? "The skipped-episodes database change has not been applied yet" : "Could not load skipped episodes"}
              </p>
              <p className="text-sm text-muted-foreground">
                {notApplied ? "Apply supabase/migrations_v2/038_skipped_duplicate_sources.sql in the Supabase SQL editor." : loadError}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // The copies that are kept, and how many facts each skipped copy already has.
  const originalIds = [...new Set(rows.map(r => r.duplicate_of).filter((x): x is string => !!x))]
  const originals = new Map<string, { title: string | null; series: string | null }>()
  for (const ids of chunk(originalIds, 100)) {
    const { data } = await db.from("sources").select("id, title, series").in("id", ids)
    for (const o of (data ?? []) as { id: string; title: string | null; series: string | null }[]) originals.set(o.id, o)
  }
  const facts = new Map<string, number>()
  for (const r of rows.filter(x => x.last_processed_at)) {
    const { count } = await db.from("raw_insights").select("id", { count: "exact", head: true }).eq("source_id", r.id)
    facts.set(r.id, count ?? 0)
  }

  const bySeries = new Map<string, number>()
  for (const r of rows) bySeries.set(r.series ?? "No Show", (bySeries.get(r.series ?? "No Show") ?? 0) + 1)
  const withFacts = rows.filter(r => (facts.get(r.id) ?? 0) > 0)

  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-6xl mx-auto">
            <div className="flex justify-between items-center mb-4">
              <h1 className="text-4xl font-bold">Skipped Episodes</h1>
              <Link href="/admin/sources">
                <Button variant="outline">Back To Sources</Button>
              </Link>
            </div>
            <p className="text-muted-foreground mb-8 max-w-3xl">
              Re-posts, rebroadcasts, short &quot;Essentials&quot; cuts, Huberman AMA and live Q&amp;A items, and second copies of an episode the
              library already holds. They are never transcribed or extracted. The reason says what each one repeats; the link goes to the copy that is kept.
            </p>

            <div className="grid gap-4 sm:grid-cols-3 mb-8">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Skipped Episodes</CardTitle></CardHeader>
                <CardContent className="text-3xl font-bold">{rows.length}</CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">By Show</CardTitle></CardHeader>
                <CardContent className="text-sm">
                  {[...bySeries].map(([s, n]) => (
                    <div key={s} className="flex justify-between"><span>{s}</span><span className="font-medium">{n}</span></div>
                  ))}
                  {bySeries.size === 0 && <span className="text-muted-foreground">None yet</span>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Already Extracted Before Skipping</CardTitle></CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">{withFacts.length}</div>
                  <p className="text-xs text-muted-foreground mt-1">Their facts stay in the claims until someone approves retiring them.</p>
                </CardContent>
              </Card>
            </div>

            {rows.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-muted-foreground">No episodes are skipped.</CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Show</TableHead>
                        <TableHead>Skipped Episode</TableHead>
                        <TableHead>Why It Was Skipped</TableHead>
                        <TableHead>Copy Kept</TableHead>
                        <TableHead className="text-right">Facts</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map(r => {
                        const kept = r.duplicate_of ? originals.get(r.duplicate_of) : null
                        const n = facts.get(r.id) ?? 0
                        return (
                          <TableRow key={r.id}>
                            <TableCell className="whitespace-nowrap">{r.series ?? "—"}</TableCell>
                            <TableCell className="max-w-sm">
                              <Link href={`/sources/${r.id}`} className="hover:underline">{r.title ?? "Untitled"}</Link>
                            </TableCell>
                            <TableCell className="max-w-xs text-sm text-muted-foreground">{r.skip_reason ?? "—"}</TableCell>
                            <TableCell className="max-w-sm">
                              {r.duplicate_of ? (
                                <Link href={`/sources/${r.duplicate_of}`} className="hover:underline">
                                  {kept?.title ?? r.duplicate_of}
                                </Link>
                              ) : (
                                <span className="text-muted-foreground">Not in the library</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">{n > 0 ? n : "—"}</TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
