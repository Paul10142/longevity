"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowRight } from "lucide-react"
import type { Lever } from "@/lib/levers"
import { cn } from "@/lib/utils"

interface LeverGridProps {
  highlightedLevers?: string[]
  levers?: Lever[] // Optional: if provided, use these; otherwise fetch from API
}

export function LeverGrid({ highlightedLevers = [], levers: leversProp }: LeverGridProps) {
  const [levers, setLevers] = useState<Lever[]>(leversProp || [])
  const [isLoading, setIsLoading] = useState(!leversProp)

  useEffect(() => {
    // If levers are provided as props, use them
    if (leversProp) {
      setLevers(leversProp)
      setIsLoading(false)
      return
    }

    // Otherwise, fetch from API
    async function fetchLevers() {
      try {
        const response = await fetch("/api/levers")
        if (!response.ok) {
          throw new Error("Failed to fetch levers")
        }
        const data = await response.json()
        setLevers(data)
      } catch (error) {
        console.error("Error fetching levers:", error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchLevers()
  }, [leversProp])

  if (isLoading) {
    return (
      <section className="py-16 lg:py-24">
        <div className="container px-4 sm:px-8">
          <div className="max-w-6xl mx-auto">
            <div className="text-center">
              <p className="text-muted-foreground">Loading levers...</p>
            </div>
          </div>
        </div>
      </section>
    )
  }

  if (levers.length === 0) {
    return (
      <section className="py-16 lg:py-24">
        <div className="container px-4 sm:px-8">
          <div className="max-w-6xl mx-auto">
            <div className="text-center">
              <p className="text-muted-foreground">No levers found.</p>
            </div>
          </div>
        </div>
      </section>
    )
  }
  return (
    <section className="py-16 lg:py-24">
      <div className="container px-4 sm:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4 text-primary">
              The 5 levers that drive your long-term health
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Longevity isn't a separate tab — it's the outcome of consistently pulling these levers.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {levers.map((lever) => {
              const isHighlighted = highlightedLevers.includes(lever.id)
              
              return (
                <Card
                  key={lever.id}
                  className={cn(
                    "transition-all duration-300 hover:shadow-lg",
                    isHighlighted && "ring-2 ring-primary ring-offset-2"
                  )}
                >
                  <CardHeader>
                    <CardTitle className="text-2xl">{lever.name}</CardTitle>
                    <CardDescription className="text-base">
                      {lever.tagline}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2 text-sm text-muted-foreground">
                      {lever.primaryBenefits.slice(0, 3).map((benefit, index) => (
                        <li key={index} className="flex items-start">
                          <span className="mr-2 text-primary">•</span>
                          <span>{benefit}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                  <CardFooter>
                    <Button
                      asChild
                      variant="outline"
                      className="w-full group"
                    >
                      <Link href={`/lever/${lever.id}`}>
                        Explore {lever.name}
                        <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
                      </Link>
                    </Button>
                  </CardFooter>
                </Card>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

