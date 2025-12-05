import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { supabaseAdmin } from "@/lib/supabaseServer"

export default async function AdminSourcesPage() {
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
            <p className="text-xs text-muted-foreground mt-2">
              Required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY
            </p>
          </div>
        </div>
        </main>
      </div>
    )
  }

  let sources = null
  let error = null

  try {
    const result = await supabaseAdmin
      .from('sources')
      .select('*')
      .order('created_at', { ascending: false })
    
    sources = result.data
    error = result.error

    if (error) {
      console.error('Error fetching sources:', error)
      console.error('Error code:', error.code)
      console.error('Error message:', error.message)
      console.error('Error details:', error.details)
      console.error('Error hint:', error.hint)
    }
  } catch (err) {
    console.error('Exception fetching sources:', err)
    error = err as any
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background">
        <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-6xl mx-auto">
            <div className="flex justify-between items-center mb-8">
              <h1 className="text-4xl font-bold">Sources</h1>
              <Link href="/admin/sources/new">
                <Button>New Source</Button>
              </Link>
            </div>
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-red-600 mb-2 font-semibold">Error loading sources</p>
                <p className="text-sm text-muted-foreground mb-2">
                  {error.message || error.details || 'Unknown error occurred'}
                </p>
                {error.code && (
                  <p className="text-xs text-muted-foreground">
                    Error code: {error.code}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-4">
                  Check browser console and server logs for more details
                </p>
                <div className="mt-6">
                  <Link href="/admin/sources/new">
                    <Button variant="outline">Continue to Add New Source</Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <main>
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-6xl mx-auto">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-4xl font-bold">Sources</h1>
            <Link href="/admin/sources/new">
              <Button>New Source</Button>
            </Link>
          </div>

          {sources && sources.length > 0 ? (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Authors</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sources.map((source: any) => (
                      <TableRow key={source.id}>
                        <TableCell className="font-medium">{source.title}</TableCell>
                        <TableCell className="capitalize">{source.type}</TableCell>
                        <TableCell>
                          {source.authors && source.authors.length > 0
                            ? source.authors.join(", ")
                            : "-"}
                        </TableCell>
                        <TableCell>
                          {source.date 
                            ? new Date(source.date).toLocaleDateString('en-US', { 
                                month: '2-digit', 
                                day: '2-digit', 
                                year: 'numeric' 
                              })
                            : "-"}
                        </TableCell>
                        <TableCell>
                          {new Date(source.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <Link href={`/sources/${source.id}`}>
                            <Button variant="outline" size="sm">View</Button>
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
                <p className="text-muted-foreground mb-4">No sources yet.</p>
                <Link href="/admin/sources/new">
                  <Button>Create Your First Source</Button>
                </Link>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
      </main>
    </div>
  )
}

