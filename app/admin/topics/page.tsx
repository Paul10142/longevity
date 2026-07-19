import Link from "next/link"
import { Button } from "@/components/ui/button"
import { TopicsAuditClient } from "@/components/TopicsAuditClient"

export const dynamic = "force-dynamic"

export default function TopicsAuditPage() {
  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Topics</h1>
                <p className="text-muted-foreground mt-1">
                  The AI-managed taxonomy. Rename, move, merge, or archive topics — every edit is
                  recorded as human-reviewed.
                </p>
              </div>
              <Link href="/admin/sources">
                <Button variant="ghost" size="sm">← Sources</Button>
              </Link>
            </div>
            <TopicsAuditClient />
          </div>
        </div>
      </main>
    </div>
  )
}
