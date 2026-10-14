import Link from "next/link"
import { Button } from "@/components/ui/button"
import { FlagReviewClient } from "@/components/FlagReviewClient"

export const dynamic = "force-dynamic"

export default function FlagReviewPage() {
  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Review Flagged Facts</h1>
                <p className="text-muted-foreground mt-1">
                  Facts the system wasn’t sure it could trust. Keep the ones that look right;
                  dismiss any flag that was a false alarm.
                </p>
                <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
                  Facts flagged as <strong className="font-medium text-foreground">may not match the source</strong> are
                  hidden from articles until you rule on them. Dismissing the flag puts the fact back;
                  confirming the issue keeps it hidden.
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
