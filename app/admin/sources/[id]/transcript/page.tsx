import Link from "next/link"
import { notFound } from "next/navigation"
import { EpisodeLinks } from "@/components/EpisodeLinks"
import { TranscriptReader } from "@/components/TranscriptReader"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { describeTranscriptView } from "@/lib/transcriptView"
import {
  buildTranscriptPayload,
  transcriptHeading,
  TRANSCRIPT_SOURCE_COLUMNS,
  type TranscriptSourceRow,
} from "@/lib/transcriptPayload"

/**
 * The readable transcript as a full page, so it can sit in its own tab next
 * to the insights being reviewed. Same rendering as the pop-up
 * (components/TranscriptReader), plus the episode title and public links.
 *
 * Under /admin, so middleware.ts requires an admin session.
 */

export const dynamic = "force-dynamic"

export default async function SourceTranscriptPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  if (!supabaseAdmin) {
    return (
      <div className="container mx-auto px-4 py-12">
        <h1 className="text-2xl font-bold">Configuration required</h1>
        <p className="text-muted-foreground mt-2">Supabase environment variables are not set.</p>
      </div>
    )
  }

  const { data, error } = await supabaseAdmin
    .from("sources")
    .select(TRANSCRIPT_SOURCE_COLUMNS)
    .eq("id", id)
    .maybeSingle()

  if (error) {
    return (
      <div className="container mx-auto px-4 py-12">
        <h1 className="text-2xl font-bold">Transcript</h1>
        <p className="text-destructive mt-2">Could not load this source: {error.message}</p>
      </div>
    )
  }
  if (!data) notFound()

  const payload = buildTranscriptPayload(data as unknown as TranscriptSourceRow)
  const title = transcriptHeading(payload)
  const insightsHref = payload.title
    ? `/admin/insights/review?source=${encodeURIComponent(payload.title)}`
    : "/admin/insights/review"

  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-10">
          <div className="mx-auto max-w-4xl space-y-6">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <Link href="/admin/sources" className="hover:text-foreground">← Sources</Link>
              <Link href={`/sources/${payload.id}`} className="hover:text-foreground">Source page</Link>
              <Link href={insightsHref} className="hover:text-foreground">Insights from this episode</Link>
            </div>

            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Transcript</p>
              <h1 className="mt-1 text-2xl font-bold leading-snug sm:text-3xl">{title}</h1>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                <span>{describeTranscriptView(payload.view)}</span>
                <EpisodeLinks links={payload.links} className="text-sm" />
              </div>
            </div>

            <TranscriptReader view={payload.view} videoUrl={payload.videoUrl} />
          </div>
        </div>
      </main>
    </div>
  )
}
