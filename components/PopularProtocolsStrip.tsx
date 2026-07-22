"use client"

import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ArrowRight, Clock } from "lucide-react"
import { cn } from "@/lib/utils"

// Synchronous lever name lookup for client components.
// Keep these labels in sync with LEVER_CONFIG in lib/levers.ts.
const LEVER_NAMES: Record<string, string> = {
  sleep: "Sleep",
  exercise: "Exercise",
  nutrition: "Nutrition",
  "mental-health": "Mental & Emotional Health",
  "drugs-supplements": "Medications & Supplements",
}

// TODO: Replace this hard-coded array with real generated protocols from the
// `topic_protocols` table. Until then these are editorial cards that link to
// the relevant topic page, so the card title is broader than its destination.
type PopularProtocol = {
  id: string
  title: string
  description: string
  leverId: string // Maps to one of the 5 core levers
  topicSlug: string // v2 topics.slug — destination for the card link
  timeCommitment?: string // e.g., "15-30 min/day", "3x/week"
}

// Hard-coded popular protocols for now.
// topicSlug values must match live rows in `topics`; a wrong slug renders a 404.
const POPULAR_PROTOCOLS: PopularProtocol[] = [
  {
    id: "sleep-hygiene",
    title: "Sleep Hygiene Protocol",
    description: "Optimize your sleep environment and schedule for better rest and recovery",
    leverId: "sleep",
    topicSlug: "sleep-circadian-rhythm",
    timeCommitment: "5-10 min/day"
  },
  {
    id: "zone-2-training",
    title: "Zone 2 Cardio Protocol",
    description: "Build cardiovascular fitness with low-intensity steady-state training",
    leverId: "exercise",
    topicSlug: "exercise",
    timeCommitment: "3-4x/week, 30-45 min"
  },
  {
    id: "strength-basics",
    title: "Foundational Strength Training",
    description: "Essential strength movements for longevity and functional capacity",
    leverId: "exercise",
    topicSlug: "exercise",
    timeCommitment: "2-3x/week, 45-60 min"
  },
  {
    id: "whole-foods-focus",
    title: "Whole Foods Nutrition",
    description: "Simple, sustainable approach to eating that minimizes processed foods",
    leverId: "nutrition",
    topicSlug: "nutrition",
    timeCommitment: "Daily"
  },
  {
    id: "stress-management",
    title: "Stress Management Basics",
    description: "Evidence-based techniques for managing stress and improving mental resilience",
    leverId: "mental-health",
    topicSlug: "mental-health",
    timeCommitment: "10-20 min/day"
  },
  {
    id: "evidence-supplements",
    title: "Evidence-Based Supplements",
    description: "The few supplements with strong scientific support, when basics are covered",
    leverId: "drugs-supplements",
    topicSlug: "medications-supplements",
    timeCommitment: "Daily"
  }
]

interface PopularProtocolsStripProps {
  /** Optional lever ID to filter protocols by a specific lever */
  leverId?: string
  /** Maximum number of protocols to display (default: all) */
  maxProtocols?: number
  /** Optional className for the container */
  className?: string
}

export function PopularProtocolsStrip({ 
  leverId,
  maxProtocols,
  className 
}: PopularProtocolsStripProps) {
  // Filter by lever if specified
  let protocols = leverId 
    ? POPULAR_PROTOCOLS.filter(p => p.leverId === leverId)
    : POPULAR_PROTOCOLS

  // Limit number of protocols if specified
  if (maxProtocols) {
    protocols = protocols.slice(0, maxProtocols)
  }

  // If no protocols match, show empty state
  if (protocols.length === 0) {
    return (
      <section className={cn("py-16 lg:py-24 bg-muted/20", className)}>
        <div className="container px-4 sm:px-8">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-8 text-primary text-center">
              Popular Protocols
            </h2>
            <div className="text-center text-muted-foreground">
              <p>No protocols available at this time.</p>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className={cn("py-16 lg:py-24 bg-muted/20", className)}>
      <div className="container px-4 sm:px-8">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-semibold mb-4 text-primary text-center">
            Popular Protocols
          </h2>
          <p className="text-lg text-muted-foreground mb-8 text-center max-w-2xl mx-auto">
            Evidence-based protocols you can start implementing today
          </p>
          
          {/* Horizontal scroll on mobile, grid on desktop */}
          <div className="flex gap-4 overflow-x-auto pb-4 md:grid md:grid-cols-2 lg:grid-cols-3 md:overflow-x-visible md:pb-0 scrollbar-hide">
            {protocols.map((protocol) => {
              const leverName = LEVER_NAMES[protocol.leverId]
              
              return (
                <Link
                  key={protocol.id}
                  href={`/topics/${protocol.topicSlug}`}
                  className="flex-shrink-0 w-[280px] md:w-auto"
                >
                  <Card className="h-full hover:shadow-lg transition-shadow duration-200 border-2 hover:border-primary/50">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <CardTitle className="text-xl leading-tight">
                          {protocol.title}
                        </CardTitle>
                        <ArrowRight className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-1" />
                      </div>
                      {leverName && (
                        <Badge 
                          variant="secondary" 
                          className="w-fit text-xs"
                        >
                          {leverName}
                        </Badge>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <CardDescription className="text-sm leading-relaxed">
                        {protocol.description}
                      </CardDescription>
                      {protocol.timeCommitment && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Clock className="h-4 w-4" />
                          <span>{protocol.timeCommitment}</span>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
