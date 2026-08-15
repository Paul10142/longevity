import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { FidelityWorksheetClient } from "@/components/FidelityWorksheetClient"

export const dynamic = "force-dynamic"

const VERDICT_GUIDE = [
  {
    name: "FAITHFUL",
    dot: "bg-emerald-500",
    meaning:
      "The statement only says things the excerpt backs up. Rewording and compressing are fine — it just can't add, drop, or stretch meaning.",
    example: "The extraction did its job.",
  },
  {
    name: "ADDED DETAIL",
    dot: "bg-red-500",
    meaning:
      "The statement contains something the excerpt never said — a number, mechanism, recommendation, or stronger certainty.",
    example:
      "Excerpt: “sleep affects metabolism” → Statement: “sleep deprivation raises insulin resistance by 30%.” The 30% came from nowhere.",
  },
  {
    name: "DROPPED QUALIFIER",
    dot: "bg-amber-500",
    meaning:
      "A caveat that changes the meaning got lost, making the claim broader or stronger than the source.",
    example: "Excerpt: “this may help in postmenopausal women” → Statement: “this helps.”",
  },
  {
    name: "UNRESOLVED REFERENCE",
    dot: "bg-amber-500",
    meaning:
      "The statement leans on context the excerpt doesn't contain (“this approach”, “the study”), so it can't stand alone or be verified.",
    example: "You can't check it against what's shown.",
  },
] as const

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

            <Card>
              <CardContent className="pt-5">
                <p className="text-sm font-medium mb-3">
                  On each card: the bold statement is what the AI <em>extracted</em>; the transcript excerpt is
                  what was <em>actually said</em>. Your question is always — does the statement stay inside what
                  the excerpt supports?
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {VERDICT_GUIDE.map(v => (
                    <div key={v.name} className="text-sm">
                      <div className="flex items-center gap-2 font-semibold">
                        <span className={`h-2.5 w-2.5 rounded-full ${v.dot}`} />
                        {v.name}
                      </div>
                      <p className="text-muted-foreground mt-0.5">{v.meaning}</p>
                      <p className="text-xs text-muted-foreground/80 mt-0.5 italic">{v.example}</p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  Rule of thumb: <strong>ADDED</strong> = says too much · <strong>DROPPED</strong> = promises too
                  much · <strong>UNRESOLVED</strong> = depends on something you can&apos;t see. When torn between
                  FAITHFUL and a violation, pick the violation — the judge is supposed to be strict.
                </p>
              </CardContent>
            </Card>

            <FidelityWorksheetClient />
          </div>
        </div>
      </main>
    </div>
  )
}
