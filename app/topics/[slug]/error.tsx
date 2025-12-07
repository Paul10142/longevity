"use client"

import { useEffect } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { AlertCircle, RefreshCw } from "lucide-react"
import Link from "next/link"

export default function TopicError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Log error for debugging
    console.error("Topic page error:", error)
  }, [error])

  const isNetworkError = 
    error.message.includes("network") ||
    error.message.includes("fetch") ||
    error.message.includes("ECONNREFUSED") ||
    error.message.includes("timeout") ||
    error.name === "TypeError"

  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-4xl mx-auto">
            <div className="mb-8">
              <Link href="/topics" className="text-sm text-muted-foreground hover:text-primary mb-4 inline-block">
                ← Back to Topics
              </Link>
            </div>

            <Card>
              <CardContent className="py-12">
                <Alert variant="destructive" className="mb-6">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Error Loading Topic</AlertTitle>
                  <AlertDescription className="mt-2">
                    {isNetworkError ? (
                      <>
                        <p className="mb-2">
                          A network error occurred while loading this topic. This might be a temporary connection issue.
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Error: {error.message || "Network request failed"}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="mb-2">
                          An error occurred while loading this topic.
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {error.message || "Unknown error occurred"}
                        </p>
                      </>
                    )}
                    {error.digest && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Error ID: {error.digest}
                      </p>
                    )}
                  </AlertDescription>
                </Alert>

                <div className="flex gap-4">
                  <Button onClick={reset} variant="default">
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Try Again
                  </Button>
                  <Link href="/topics">
                    <Button variant="outline">
                      Back to Topics
                    </Button>
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

