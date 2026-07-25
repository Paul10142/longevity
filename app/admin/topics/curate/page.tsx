import Link from "next/link"
import { Button } from "@/components/ui/button"
import { TopicCurationClient } from "@/components/TopicCurationClient"

export const dynamic = "force-dynamic"

export default function TopicCurationPage() {
  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-10">
          <div className="mb-6 flex items-start justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Curate topics</h1>
              <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
                Drag a topic onto another to <b>merge</b> it in; hold <b>Shift</b> while dropping to <b>nest</b> it
                under; drop on a pillar header to move it into that pillar; click a name to <b>rename</b>. Changes stage
                into a plan on the right and only touch the database when you press <b>Apply</b>. Rule of thumb: fewer
                topics, max&nbsp;3&nbsp;levels — start small and merge up.
              </p>
            </div>
            <Link href="/admin/topics">
              <Button variant="ghost" size="sm">← Audit view</Button>
            </Link>
          </div>
          <TopicCurationClient />
        </div>
      </main>
    </div>
  )
}
