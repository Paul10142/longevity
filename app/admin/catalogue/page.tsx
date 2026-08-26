import Link from "next/link"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { CatalogueClient, type CatalogueRow } from "@/components/CatalogueClient"
import { Card, CardContent } from "@/components/ui/card"

/**
 * Episode catalogue across every show.
 *
 * Reads `admin_source_list()` rather than selecting from `sources` directly:
 * that function exists (migration 019) because `select('*')` dragged ~42 MB of
 * transcript text through PostgREST on every load and started tripping the
 * statement timeout. It returns aggregates and no transcript body.
 */

export const dynamic = "force-dynamic"

export default async function AdminCataloguePage() {
  if (!supabaseAdmin) {
    return (
      <div className="container mx-auto px-4 py-12">
        <h1 className="text-2xl font-bold">Configuration required</h1>
        <p className="text-muted-foreground mt-2">Supabase environment variables are not set.</p>
      </div>
    )
  }

  const { data, error } = await supabaseAdmin.rpc("admin_source_list")

  if (error) {
    return (
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-4xl font-bold mb-6">Catalogue</h1>
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-destructive font-semibold mb-2">Could not load the catalogue</p>
              <p className="text-sm text-muted-foreground">{error.message}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  const rows: CatalogueRow[] = (data ?? []).map(
    (r: {
      id: string
      series: string | null
      title: string | null
      episode_number: number | null
      date: string | null
      url: string | null
      processing_status: string | null
      transcript_origin: string | null
      word_count: number | null
      insights_count: number | string | null
    }) => ({
      id: r.id,
      series: r.series,
      title: r.title,
      episode_number: r.episode_number,
      date: r.date,
      url: r.url,
      processing_status: r.processing_status,
      transcript_origin: r.transcript_origin,
      word_count: Number(r.word_count ?? 0),
      // bigint arrives as a string over PostgREST; Number() it once here so no
      // consumer has to remember.
      insights_count: Number(r.insights_count ?? 0),
    })
  )

  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-baseline justify-between mb-2">
              <h1 className="text-4xl font-bold">Catalogue</h1>
              <Link href="/admin" className="text-sm text-muted-foreground hover:text-foreground">
                ← Admin
              </Link>
            </div>
            <p className="text-muted-foreground mb-8">
              Every episode across every show, and how far each one has got.
            </p>
            <CatalogueClient rows={rows} />
          </div>
        </div>
      </main>
    </div>
  )
}
