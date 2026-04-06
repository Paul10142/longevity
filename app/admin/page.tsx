import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const mainLinks = [
  { name: "Topics", href: "/admin/topics", description: "Topic pages and evidence" },
  { name: "Sources", href: "/admin/sources", description: "Ingested sources and transcripts" },
  { name: "Concepts", href: "/admin/concepts", description: "Concept list and tagging" },
] as const

const insightLinks = [
  { name: "Review", href: "/admin/insights/review", description: "Review raw insights" },
  { name: "Unique", href: "/admin/insights/unique", description: "Curated unique insights" },
  { name: "Clusters", href: "/admin/insights/clusters", description: "Insight clusters" },
] as const

export default function AdminHomePage() {
  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-3xl mx-auto space-y-10">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Workbench</h1>
              <p className="text-muted-foreground mt-2">
                Quick links match the navigation above. Add a new source from the Sources page.
              </p>
            </div>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Library &amp; topics</CardTitle>
                <CardDescription>Primary editing areas</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-3">
                {mainLinks.map((item) => (
                  <Button key={item.href} asChild variant="secondary" className="h-auto flex-col items-stretch py-3 px-4">
                    <Link href={item.href}>
                      <span className="font-semibold">{item.name}</span>
                      <span className="text-xs font-normal text-muted-foreground mt-0.5 max-w-[14rem] text-left">
                        {item.description}
                      </span>
                    </Link>
                  </Button>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Insights</CardTitle>
                <CardDescription>Deduplication and review</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-3">
                {insightLinks.map((item) => (
                  <Button key={item.href} asChild variant="outline" className="h-auto flex-col items-stretch py-3 px-4">
                    <Link href={item.href}>
                      <span className="font-semibold">{item.name}</span>
                      <span className="text-xs font-normal text-muted-foreground mt-0.5 max-w-[14rem] text-left">
                        {item.description}
                      </span>
                    </Link>
                  </Button>
                ))}
              </CardContent>
            </Card>

            <p className="text-xs text-muted-foreground">
              <Link href="/" className="underline underline-offset-2 hover:text-foreground">
                Back to public site
              </Link>
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
