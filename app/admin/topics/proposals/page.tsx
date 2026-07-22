import Link from "next/link"
import { Button } from "@/components/ui/button"
import { TopicProposalsClient } from "@/components/TopicProposalsClient"

export const dynamic = "force-dynamic"

export default function TopicProposalsPage() {
  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Topic Approvals</h1>
                <p className="text-muted-foreground mt-1">
                  New branches the pipeline wanted but did not create. Tagging files claims into the
                  existing tree by itself and may add children under an approved topic — only a
                  genuinely new area reaches this queue.
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Link href="/admin/topics">
                  <Button variant="ghost" size="sm">
                    Topics
                  </Button>
                </Link>
                <Link href="/admin">
                  <Button variant="ghost" size="sm">
                    ← Admin
                  </Button>
                </Link>
              </div>
            </div>
            <TopicProposalsClient />
          </div>
        </div>
      </main>
    </div>
  )
}
