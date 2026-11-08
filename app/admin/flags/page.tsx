import Link from "next/link"
import { Button } from "@/components/ui/button"
import { FlagReviewClient } from "@/components/FlagReviewClient"

export const dynamic = "force-dynamic"

export default function FlagReviewPage() {
  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-5xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Review Flagged Facts</h1>
                <p className="text-muted-foreground mt-1">
                  Each hidden fact shows the judge’s reason, the transcript around it, and a link to the
                  video 30 seconds earlier.
                </p>
                <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
                  Approve As Is puts the fact back in articles. Reject keeps it hidden. Edit and Approve
                  fixes the wording and puts it back. Needs Video Check keeps it hidden for facts that
                  depend on something only visible on screen.
                </p>
              </div>
              <Link href="/admin/sources">
                <Button variant="ghost" size="sm">← Sources</Button>
              </Link>
            </div>
            <FlagReviewClient />
          </div>
        </div>
      </main>
    </div>
  )
}
