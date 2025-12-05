import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function MedicalLibraryPage() {
  return (
    <div className="min-h-screen bg-background">
      <main>
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl font-bold mb-8">Sources</h1>
          <p className="text-lg text-muted-foreground mb-8">
            Browse evidence-based insights extracted from podcasts, books, and articles.
          </p>
          
          <div className="grid gap-4 mb-8">
            <Card>
              <CardHeader>
                <CardTitle>Admin</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-4">
                  <Link href="/admin/sources">
                    <Button>Manage Sources</Button>
                  </Link>
                  <Link href="/admin/sources/new">
                    <Button variant="outline">Add New Source</Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Coming Soon</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                Sources will display insights from processed sources. 
                Use the admin panel to add and process new sources.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
      </main>
    </div>
  )
}

