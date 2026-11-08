import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { listReviewRows } from "@/lib/speakerReviewData"

export const dynamic = "force-dynamic"

const pill = "inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap"

function ExtractionStatus({ status }: { status: string | null }) {
  switch (status) {
    case "succeeded":
      return <span className={`${pill} bg-emerald-500/10 text-emerald-700 dark:text-emerald-400`}>Extracted</span>
    case "processing":
      return <span className={`${pill} bg-amber-500/10 text-amber-700 dark:text-amber-500`}>Extracting…</span>
    case "failed":
      return <span className={`${pill} bg-destructive/10 text-destructive`}>Failed</span>
    case "pending":
      return <span className={`${pill} bg-muted text-muted-foreground`}>Queued</span>
    default:
      return <span className={`${pill} bg-muted text-muted-foreground`}>{status ?? "Unknown"}</span>
  }
}

export default async function SpeakersPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const { all } = await searchParams
  const includeExtracted = all === "1"
  const { rows, columnMissing, error } = await listReviewRows(includeExtracted)
  const needs = rows.filter(r => Object.keys(r.saved).length === 0)
  const assigned = rows.filter(r => Object.keys(r.saved).length > 0)

  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-5xl mx-auto space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Assign Speakers</h1>
                <p className="text-muted-foreground mt-1 max-w-2xl">
                  Some episodes have voices the transcription could not name (Speaker 2, Speaker 3 …). Open one, listen to
                  the first thing each voice says, and click who it is. Your answers are saved on the episode and reach the
                  transcript when the episode is re-attached.
                </p>
              </div>
              <Link href="/admin/sources">
                <Button variant="ghost" size="sm">← Sources</Button>
              </Link>
            </div>

            {columnMissing && (
              <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                Migration 039 (the column that stores your answers) is not applied yet, so you can look at episodes here
                but not save.
              </p>
            )}
            {error && <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">Could not load episodes: {error}</p>}

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-xl">
                  Needs Review ({needs.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <EpisodeTable rows={needs} empty="Every diarized episode here has been reviewed." />
              </CardContent>
            </Card>

            {assigned.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-xl">Assigned ({assigned.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <EpisodeTable rows={assigned} empty="" />
                  <p className="mt-3 text-xs text-muted-foreground">
                    Open an episode to see whether its names are already in the transcript or still waiting for the re-attach.
                  </p>
                </CardContent>
              </Card>
            )}

            <p className="text-sm text-muted-foreground">
              {includeExtracted ? (
                <>
                  Showing episodes that were already extracted too. A re-attach skips those, so new names reach them only
                  after they are retired and extracted again.{" "}
                  <Link href="/admin/speakers" className="underline underline-offset-4">Hide Extracted Episodes</Link>
                </>
              ) : (
                <>
                  Episodes that are already extracted are hidden (a re-attach skips them).{" "}
                  <Link href="/admin/speakers?all=1" className="underline underline-offset-4">Include Extracted Episodes</Link>
                  {" "}(slower).
                </>
              )}
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}

function EpisodeTable({
  rows,
  empty,
}: {
  rows: Awaited<ReturnType<typeof listReviewRows>>["rows"]
  empty: string
}) {
  if (rows.length === 0) return empty ? <p className="text-sm text-muted-foreground">{empty}</p> : null
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Episode</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Guests On The Row</TableHead>
          <TableHead>Extraction</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(r => (
          <TableRow key={r.id}>
            <TableCell className="whitespace-nowrap font-mono text-xs">{r.external_id ?? "—"}</TableCell>
            <TableCell>
              <Link href={`/admin/speakers/${r.id}`} className="font-medium underline-offset-4 hover:underline">
                {r.title ?? "(untitled)"}
              </Link>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">{(r.authors ?? []).slice(1).join(", ") || "None listed"}</TableCell>
            <TableCell><ExtractionStatus status={r.processing_status} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
