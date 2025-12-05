import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { supabaseAdmin } from "@/lib/supabaseServer"

// Cache topics list for 5 minutes
export const revalidate = 300

export default async function TopicsPage() {
  if (!supabaseAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <main>
        <div className="flex items-center justify-center min-h-[calc(100vh-4rem)]">
          <div className="text-center">
            <h1 className="text-2xl font-bold mb-4">Configuration Required</h1>
            <p className="text-muted-foreground">
              Please set up your Supabase environment variables in .env.local
            </p>
          </div>
        </div>
        </main>
      </div>
    )
  }

  const { data: concepts, error } = await supabaseAdmin
    .from("concepts")
    .select("*")
    .order("name", { ascending: true })

  if (error) {
    console.error("Error fetching concepts:", error)
  }

  return (
    <div className="min-h-screen bg-background">
      <main>
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-6xl mx-auto">
          <div className="mb-8">
            <h1 className="text-4xl font-bold mb-4">Topics</h1>
            <p className="text-lg text-muted-foreground">
              Browse insights organized by topic across all sources
            </p>
          </div>

          {concepts && concepts.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {concepts.map((concept: any) => (
                <Link key={concept.id} href={`/topics/${concept.slug}`}>
                  <Card className="h-full hover:shadow-lg transition-shadow cursor-pointer">
                    <CardHeader>
                      <CardTitle className="text-xl">{concept.name}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription>{concept.description}</CardDescription>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground">
                  No topics available yet. Concepts need to be seeded in the database.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
      </main>
    </div>
  )
}
