import Link from "next/link"
import { Button } from "@/components/ui/button"
import { TopicCurationClient } from "@/components/TopicCurationClient"

export const dynamic = "force-dynamic"

/**
 * The drag-and-drop board IS the Topics page (Paul's call, 2026-08-15 — the
 * audit list offered nothing the board doesn't, so it lives on at
 * /admin/topics/audit as a fallback list view).
 */
export default function TopicsPage() {
  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-10">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Topics</h1>
              <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
                Drag a topic onto another and choose <b>Merge into it</b> or <b>Nest under it</b>; drop on a
                pillar header to move it into that pillar; click a name to <b>rename</b>; click{" "}
                <b>☐ approve</b> on an AI topic to sign it off as-is. Changes stage into a plan and only touch
                the database when you press <b>Apply</b>. Rule of thumb: fewer topics, max&nbsp;3&nbsp;levels —
                start small and merge up.
              </p>
            </div>
            <Link href="/admin/topics/audit" className="shrink-0">
              <Button variant="ghost" size="sm">List view</Button>
            </Link>
          </div>
          <TopicCurationClient />
        </div>
      </main>
    </div>
  )
}
