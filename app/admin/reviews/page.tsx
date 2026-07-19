import Link from "next/link"
import { Button } from "@/components/ui/button"
import { MergeReviewClient } from "@/components/MergeReviewClient"

export const dynamic = "force-dynamic"

export default function ReviewQueuePage() {
  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Merge review queue</h1>
                <p className="text-muted-foreground mt-1">
                  Borderline deduplication decisions. Merge folds the new claim into the existing one;
                  keeping them separate leaves both.
                </p>
              </div>
              <Link href="/admin/sources">
                <Button variant="ghost" size="sm">← Sources</Button>
              </Link>
            </div>
            <MergeReviewClient />
          </div>
        </div>
      </main>
    </div>
  )
}
