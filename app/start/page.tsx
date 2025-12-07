"use client"

import { useState, useRef, useMemo } from "react"
import { ChevronDown } from "lucide-react"
import { WhatMattersMost, type Priority } from "@/components/WhatMattersMost"
import { LeverGrid } from "@/components/LeverGrid"
import { PopularProtocolsStrip } from "@/components/PopularProtocolsStrip"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"

// Priority to lever mapping (matches WhatMattersMost component)
const PRIORITY_TO_LEVERS: Record<Priority, string[]> = {
  "more-energy": ["sleep", "exercise", "nutrition"],
  "better-sleep": ["sleep"],
  "less-stress": ["mental-health", "sleep", "exercise"],
  "healthier-weight": ["nutrition", "exercise", "sleep"],
  "better-focus": ["sleep", "mental-health", "nutrition"],
  "healthy-aging": ["exercise", "nutrition", "sleep", "mental-health"]
}

export default function StartHerePage() {
  const [selectedPriorities, setSelectedPriorities] = useState<Priority[]>([])
  const leversSectionRef = useRef<HTMLDivElement>(null)

  // Derive highlighted levers from selected priorities
  const highlightedLevers = useMemo(() => {
    const leverSet = new Set<string>()
    selectedPriorities.forEach(priority => {
      PRIORITY_TO_LEVERS[priority]?.forEach(lever => leverSet.add(lever))
    })
    return Array.from(leverSet)
  }, [selectedPriorities])

  const handlePrioritiesChange = (priorities: Priority[]) => {
    setSelectedPriorities(priorities)
    
    // Scroll to levers section if priorities are selected
    if (priorities.length > 0 && leversSectionRef.current) {
      setTimeout(() => {
        leversSectionRef.current?.scrollIntoView({ 
          behavior: "smooth",
          block: "start"
        })
      }, 100)
    }
  }

  const scrollToContent = () => {
    const nextSection = document.getElementById("overwhelm-section")
    if (nextSection) {
      nextSection.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <main>
        {/* A) Hero: Hook & Vision */}
        <section className="relative py-24 lg:py-32 min-h-[80vh] flex items-center">
          <div className="absolute inset-0 bg-gradient-to-b from-background via-background to-muted/20"></div>
          <div className="container relative px-4 sm:px-8">
            <div className="max-w-4xl mx-auto text-center">
              <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-semibold mb-6 leading-tight text-primary">
                Live better, think clearly, and stay healthy enough to keep doing the things you love.
              </h1>
              <p className="text-xl sm:text-2xl text-muted-foreground mb-12 leading-relaxed max-w-3xl mx-auto">
                Lifestyle Academy helps you understand which daily habits actually move the needle — using real evidence, not trends.
              </p>
              
              {/* Scroll indicator */}
              <button
                onClick={scrollToContent}
                className="inline-flex flex-col items-center gap-2 text-muted-foreground hover:text-primary transition-colors group"
                aria-label="Scroll to begin"
              >
                <span className="text-sm font-medium">Scroll to begin</span>
                <ChevronDown className="h-6 w-6 animate-bounce group-hover:animate-none" />
              </button>
            </div>
          </div>
        </section>

        {/* B) Overwhelm / Problem Section */}
        <section id="overwhelm-section" className="py-16 lg:py-24 bg-muted/30">
          <div className="container px-4 sm:px-8">
            <div className="max-w-4xl mx-auto">
              <h2 className="text-3xl sm:text-4xl font-semibold mb-8 text-primary text-center">
                Too much information, too little clarity
              </h2>
              
              <div className="space-y-6 text-lg text-muted-foreground">
                <p>
                  There's too much conflicting health information out there. Every day brings new podcasts, 
                  influencers, AI-generated tips, and "breakthrough" studies. It's overwhelming.
                </p>
                <p>
                  It's hard to know what's actually true, what applies to you, and what will actually move 
                  the needle for your health and longevity.
                </p>
                <p className="text-foreground font-medium">
                  Lifestyle Academy exists to replace that overwhelm with clarity.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* C) Five Levers Section */}
        <div ref={leversSectionRef}>
          <LeverGrid highlightedLevers={highlightedLevers} />
        </div>

        {/* D) "What Matters Most to You Right Now?" Interaction */}
        <WhatMattersMost 
          onChange={handlePrioritiesChange}
          highlightedLevers={highlightedLevers}
        />

        {/* E) "Our Approach: Evidence First" Section */}
        <section className="py-16 lg:py-24">
          <div className="container px-4 sm:px-8">
            <div className="max-w-4xl mx-auto">
              <h2 className="text-3xl sm:text-4xl font-semibold mb-8 text-primary text-center">
                Our approach: Evidence first
              </h2>
              
              <div className="space-y-6 text-lg text-muted-foreground mb-8">
                <p>
                  We synthesize insights from world-class researchers, physicians, and health experts. 
                  We extract the evidence from books, podcasts, and papers so you don't have to.
                </p>
                <p>
                  Every recommendation is grounded in the best available evidence and reviewed with 
                  clinician input.
                </p>
              </div>

              {/* Evidence levels badges */}
              <div className="flex flex-wrap gap-4 justify-center">
                <Badge variant="default" className="px-4 py-1.5 text-sm">
                  Strong Evidence
                </Badge>
                <Badge variant="secondary" className="px-4 py-1.5 text-sm">
                  Moderate Evidence
                </Badge>
                <Badge variant="outline" className="px-4 py-1.5 text-sm">
                  Emerging Evidence
                </Badge>
              </div>
            </div>
          </div>
        </section>

        {/* F) Popular Protocols Strip */}
        <PopularProtocolsStrip />

        {/* G) Soft CTA to Create Profile / Subscribe */}
        <section className="py-16 lg:py-24 bg-muted/30">
          <div className="container px-4 sm:px-8">
            <div className="max-w-3xl mx-auto text-center">
              <Card className="border-2 border-primary/20">
                <CardContent className="pt-8 pb-8">
                  <h2 className="text-2xl sm:text-3xl font-semibold mb-4 text-primary">
                    Turn knowledge into action
                  </h2>
                  <p className="text-lg text-muted-foreground mb-8">
                    Most of Lifestyle Academy's knowledge will be free. Our membership adds tools to 
                    turn that knowledge into a personalized action plan.
                  </p>
                  <Button 
                    size="lg" 
                    className="px-8 py-6 text-base"
                    disabled
                  >
                    See membership options
                  </Button>
                  <p className="text-sm text-muted-foreground mt-4">
                    Coming soon
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

