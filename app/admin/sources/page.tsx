import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { JobQueuePanel } from "@/components/JobQueuePanel"

/**
 * Where a source is in the pipeline.
 *
 * Without this the table showed only words + insights, so a source that was
 * merely QUEUED (transcript present, insights "-") looked identical to one that
 * had run and produced nothing — which is exactly how it got misread. The
 * genuinely alarming case (finished but extracted zero insights) is called out
 * separately rather than blending in with the queue.
 */
function SourceStatus({ status, insights }: { status: string | null; insights: number }) {
  const base = "inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap"

  if (status === "succeeded" && insights === 0) {
    return <span className={`${base} bg-destructive/10 text-destructive`}>Done · no insights</span>
  }
  switch (status) {
    case "succeeded":
      return <span className={`${base} bg-emerald-500/10 text-emerald-700 dark:text-emerald-400`}>Extracted</span>
    case "processing":
      return <span className={`${base} bg-amber-500/10 text-amber-700 dark:text-amber-500`}>Extracting…</span>
    case "failed":
      return <span className={`${base} bg-destructive/10 text-destructive`}>Failed</span>
    case "pending":
      return <span className={`${base} bg-muted text-muted-foreground`}>Queued</span>
    default:
      return <span className={`${base} bg-muted text-muted-foreground`}>{status ?? "unknown"}</span>
  }
}

export default async function AdminSourcesPage() {
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

  let sources = null
  let error = null

  try {
    // admin_source_list() (migration 019) aggregates server-side and returns no
    // transcript text. The previous `select('*')` dragged all ~42 MB of
    // transcripts through PostgREST and started failing the statement timeout
    // (57014) outright, and the per-source insight count was read from an
    // unpaginated raw_insights select — silently capped at 1000 rows by
    // PostgREST, so every count was wrong once the corpus passed 1000 insights.
    const result = await supabaseAdmin.rpc('admin_source_list')

    error = result.error

    if (error) {
      console.error('Error fetching sources:', error)
      console.error('Error code:', error.code)
      console.error('Error message:', error.message)
      console.error('Error details:', error.details)
      console.error('Error hint:', error.hint)
    } else {
      sources = (result.data ?? []).map((source: any) => ({
        ...source,
        wordCount: source.word_count ?? 0,
        insightsCount: Number(source.insights_count ?? 0),
      }))
    }
  } catch (err) {
    console.error('Exception fetching sources:', err)
    error = err as any
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background">
        <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-6xl mx-auto">
            <div className="flex justify-between items-center mb-8">
              <h1 className="text-4xl font-bold">Sources</h1>
              <div className="flex gap-2">
                <Link href="/admin/insights/review">
                  <Button variant="outline">Review Insights</Button>
                </Link>
                <Link href="/admin/sources/new">
                  <Button>New Source</Button>
                </Link>
              </div>
            </div>
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-red-600 mb-2 font-semibold">Error loading sources</p>
                <p className="text-sm text-muted-foreground mb-2">
                  {error.message || error.details || 'Unknown error occurred'}
                </p>
                {error.code && (
                  <p className="text-xs text-muted-foreground">
                    Error code: {error.code}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-4">
                  Check browser console and server logs for more details
                </p>
                <div className="mt-6">
                  <Link href="/admin/sources/new">
                    <Button variant="outline">Continue to Add New Source</Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <main>
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-6xl mx-auto">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-4xl font-bold">Sources</h1>
            <div className="flex gap-2">
              <Link href="/admin/insights/review">
                <Button variant="outline">Review Insights</Button>
              </Link>
              <Link href="/admin/sources/new">
                <Button>New Source</Button>
              </Link>
            </div>
          </div>

          <div className="mb-8">
            <JobQueuePanel />
          </div>

          {sources && sources.length > 0 ? (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Authors</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Word Count</TableHead>
                      <TableHead>Insights</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sources.map((source: any) => (
                      <TableRow key={source.id}>
                        <TableCell className="font-medium">{source.title}</TableCell>
                        <TableCell className="capitalize">{source.type}</TableCell>
                        <TableCell>
                          {source.authors && source.authors.length > 0
                            ? source.authors.join(", ")
                            : "-"}
                        </TableCell>
                        <TableCell>
                          {new Date(source.created_at).toLocaleDateString('en-US', {
                            month: '2-digit',
                            day: '2-digit',
                            year: '2-digit'
                          })}
                        </TableCell>
                        <TableCell>
                          <SourceStatus status={source.processing_status} insights={source.insightsCount} />
                        </TableCell>
                        <TableCell>
                          {source.wordCount > 0 ? source.wordCount.toLocaleString() : "-"}
                        </TableCell>
                        <TableCell>
                          {source.insightsCount > 0 ? source.insightsCount : "-"}
                        </TableCell>
                        <TableCell>
                          <Link href={`/sources/${source.id}`}>
                            <Button variant="outline" size="sm">View</Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground mb-4">No sources yet.</p>
                <Link href="/admin/sources/new">
                  <Button>Create Your First Source</Button>
                </Link>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
      </main>
    </div>
  )
}

