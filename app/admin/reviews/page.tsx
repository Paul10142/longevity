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
                <h1 className="text-3xl font-bold tracking-tight">Merge Review Queue</h1>
                <p className="text-muted-foreground mt-1">
                  Borderline deduplication decisions. Merge folds the new claim into the existing one;
                  keeping them separate leaves both.
                </p>
                {/* Paul went looking for an "enrich" button here (2026-08-16).
                    There isn't one, and shouldn't be — enrich is not a third
                    verdict, it is what Merge now does. Saying so removes the
                    fear that merging discards the newer wording's detail. */}
                <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
                  Merging does <strong className="font-medium text-foreground">not</strong> throw away the
                  new claim&apos;s wording. The surviving claim&apos;s sentence is rewritten to carry every
                  detail from both sides — numbers, populations, caveats, examples — so nothing you merge
                  here is lost from the text articles are written from.
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
