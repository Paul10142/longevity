"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

/**
 * The episode catalogue: every episode of every show, and whether we have
 * actually ingested it.
 *
 * The question this answers is "what do we have, and what is missing?" — so a
 * row exists for every episode the feed knows about, ingested or not. A page
 * that only listed processed episodes would be unable to show a gap, which is
 * the whole point.
 *
 * Filtering is client-side: ~550 rows is nothing, and it keeps the page a single
 * server round-trip. Revisit if a show ever pushes this past a few thousand.
 */

export type CatalogueRow = {
  id: string
  series: string | null
  title: string | null
  episode_number: number | null
  date: string | null
  url: string | null
  youtube_url: string | null
  article_url: string | null
  processing_status: string | null
  transcript_origin: string | null
  word_count: number
  insights_count: number
}

/**
 * One row's position in the pipeline, in the order work actually happens.
 * Deliberately NOT the raw processing_status: "succeeded with zero insights" is
 * a failure that reads as success, and "has a transcript but no claims yet" is
 * the normal waiting state that the raw status calls "pending" — the same word
 * it uses for an episode we have not even downloaded.
 */
function stageOf(r: CatalogueRow): { label: string; tone: string; rank: number } {
  if (r.processing_status === "succeeded" && r.insights_count === 0)
    return { label: "No insights", tone: "bg-destructive/10 text-destructive", rank: 5 }
  if (r.insights_count > 0)
    return { label: "Insights drafted", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", rank: 4 }
  if (r.processing_status === "processing")
    return { label: "Extracting", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-500", rank: 3 }
  if (r.transcript_origin === "deepgram" || r.word_count > 0)
    return { label: "Transcribed", tone: "bg-sky-500/10 text-sky-700 dark:text-sky-400", rank: 2 }
  return { label: "Not started", tone: "bg-muted text-muted-foreground", rank: 1 }
}

export function CatalogueClient({ rows }: { rows: CatalogueRow[] }) {
  const [series, setSeries] = useState<string>("all")
  const [stage, setStage] = useState<string>("all")
  const [q, setQ] = useState("")

  const allSeries = useMemo(
    () => [...new Set(rows.map(r => r.series).filter(Boolean))].sort() as string[],
    [rows]
  )

  const summary = useMemo(() => {
    const by = new Map<string, { total: number; transcribed: number; drafted: number }>()
    for (const r of rows) {
      const key = r.series ?? "Other"
      const cur = by.get(key) ?? { total: 0, transcribed: 0, drafted: 0 }
      cur.total++
      const st = stageOf(r)
      if (st.rank >= 2) cur.transcribed++
      if (r.insights_count > 0) cur.drafted++
      by.set(key, cur)
    }
    return [...by.entries()].sort((a, b) => b[1].total - a[1].total)
  }, [rows])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter(r => {
      if (series !== "all" && (r.series ?? "Other") !== series) return false
      if (stage !== "all" && stageOf(r).label !== stage) return false
      if (needle && !(r.title ?? "").toLowerCase().includes(needle)) return false
      return true
    })
  }, [rows, series, stage, q])

  const stages = ["Not started", "Transcribed", "Extracting", "Insights drafted", "No insights"]

  return (
    <div className="space-y-6">
      {/* At-a-glance coverage per show — the "how much have we actually got?" view. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {summary.map(([name, s]) => (
          <Card key={name}>
            <CardContent className="pt-6">
              <div className="text-sm font-semibold">{name}</div>
              <div className="mt-2 text-2xl font-bold">
                {s.drafted}
                <span className="text-base font-normal text-muted-foreground"> / {s.total} with insights</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{s.transcribed} transcribed</div>
              <div className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-emerald-500"
                  style={{ width: `${s.total ? (s.drafted / s.total) * 100 : 0}%` }}
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={series}
          onChange={e => setSeries(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="all">All shows</option>
          {allSeries.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select
          value={stage}
          onChange={e => setStage(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="all">Any stage</option>
          {stages.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search titles…"
          className="h-9 flex-1 min-w-[12rem] rounded-md border border-input bg-background px-3 text-sm"
        />
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {filtered.length} of {rows.length}
        </span>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Episode</th>
                <th className="px-3 py-2 font-medium">Show</th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium text-right">Insights</th>
                <th className="px-3 py-2 font-medium">Links</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const st = stageOf(r)
                return (
                  <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{r.episode_number ?? "—"}</td>
                    <td className="px-3 py-2 max-w-[28rem]">
                      <span className="block truncate" title={r.title ?? ""}>{r.title ?? "(untitled)"}</span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{r.series ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{r.date ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${st.tone}`}>
                        {st.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.insights_count > 0 ? r.insights_count.toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex gap-2">
                        {r.url && (
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                            Episode
                          </a>
                        )}
                        {r.youtube_url && (
                          <a href={r.youtube_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                            Video
                          </a>
                        )}
                        {r.article_url && (
                          <a href={r.article_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                            Notes
                          </a>
                        )}
                        {r.insights_count > 0 && (
                          <Link href={`/sources/${r.id}`} className="text-muted-foreground hover:underline">
                            Insights
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">Nothing matches those filters.</div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        One row per episode the feed knows about, ingested or not — so a gap is visible rather than absent.
        &ldquo;Insights drafted&rdquo; means claims have been extracted and are ready to review.
      </p>

      <div>
        <Link href="/admin/sources">
          <Button variant="outline" size="sm">Source detail &amp; job queue</Button>
        </Link>
      </div>
    </div>
  )
}

export default CatalogueClient
