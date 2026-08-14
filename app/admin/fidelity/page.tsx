import Link from "next/link"
import { Button } from "@/components/ui/button"
import { FidelityWorksheetClient } from "@/components/FidelityWorksheetClient"

export const dynamic = "force-dynamic"

export default function FidelityPage() {
  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Fidelity Labels</h1>
                <p className="text-muted-foreground mt-1 text-sm">
                  For each pair: does the extracted insight faithfully reflect the transcript excerpt?
                  Your rulings are the gold standard that certifies (or fires) the AI accuracy judge.
                  Labels save automatically; click a selected label again to clear it.
                </p>
              </div>
              <Link href="/admin" className="shrink-0">
                <Button variant="ghost" size="sm">← Admin</Button>
              </Link>
            </div>
            <FidelityWorksheetClient />
          </div>
        </div>
      </main>
    </div>
  )
}
