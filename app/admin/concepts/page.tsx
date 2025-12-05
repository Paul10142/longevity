import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { supabaseAdmin } from "@/lib/supabaseServer"

export default async function AdminConceptsPage() {
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
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-4xl font-bold">Concepts</h1>
            <Link href="/topics">
              <Button variant="outline">View Public Topics</Button>
            </Link>
          </div>

          {concepts && concepts.length > 0 ? (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Slug</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {concepts.map((concept: any) => (
                      <TableRow key={concept.id}>
                        <TableCell className="font-medium">{concept.name}</TableCell>
                        <TableCell className="text-muted-foreground">{concept.slug}</TableCell>
                        <TableCell className="text-muted-foreground">{concept.description}</TableCell>
                        <TableCell>
                          <Link href={`/admin/concepts/${concept.id}`}>
                            <Button variant="outline" size="sm">Tag Insights</Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground mb-4">No concepts found.</p>
                <p className="text-sm text-muted-foreground">
                  Run the seed migration to create initial concepts.
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
