"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type Priority = 
  | "more-energy"
  | "better-sleep"
  | "less-stress"
  | "healthier-weight"
  | "better-focus"
  | "healthy-aging"

type PriorityConfig = {
  id: Priority
  label: string
  relevantLevers: string[] // lever IDs
}

const PRIORITIES: PriorityConfig[] = [
  {
    id: "more-energy",
    label: "More energy",
    relevantLevers: ["sleep", "exercise", "nutrition"]
  },
  {
    id: "better-sleep",
    label: "Better sleep",
    relevantLevers: ["sleep"]
  },
  {
    id: "less-stress",
    label: "Less stress",
    relevantLevers: ["mental-health", "sleep", "exercise"]
  },
  {
    id: "healthier-weight",
    label: "Healthier weight",
    relevantLevers: ["nutrition", "exercise", "sleep"]
  },
  {
    id: "better-focus",
    label: "Better focus",
    relevantLevers: ["sleep", "mental-health", "nutrition"]
  },
  {
    id: "healthy-aging",
    label: "Healthy aging",
    relevantLevers: ["exercise", "nutrition", "sleep", "mental-health"]
  }
]

const STORAGE_KEY = "lifestyleAcademy.priorities"

interface WhatMattersMostProps {
  /** Callback when priorities change, receives array of selected priority IDs */
  onChange?: (selectedPriorities: Priority[]) => void
  /** Optional array of lever IDs to highlight (derived from selected priorities) */
  highlightedLevers?: string[]
}

export function WhatMattersMost({ 
  onChange,
  highlightedLevers = []
}: WhatMattersMostProps) {
  const [selectedPriorities, setSelectedPriorities] = useState<Priority[]>([])

  // Load from localStorage on mount
  useEffect(() => {
    if (typeof window === "undefined") return

    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as Priority[]
        // Validate that all stored priorities are valid
        const validPriorities = parsed.filter((p): p is Priority =>
          PRIORITIES.some(priority => priority.id === p)
        )
        if (validPriorities.length > 0) {
          setSelectedPriorities(validPriorities)
          // Notify parent of initial selection
          if (onChange) {
            onChange(validPriorities)
          }
        }
      }
    } catch (error) {
      console.warn("Failed to load priorities from localStorage:", error)
    }
  }, [onChange])

  // Save to localStorage whenever selection changes
  useEffect(() => {
    if (typeof window === "undefined") return

    try {
      if (selectedPriorities.length > 0) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedPriorities))
      } else {
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch (error) {
      console.warn("Failed to save priorities to localStorage:", error)
    }
  }, [selectedPriorities])

  const handlePriorityClick = (priority: PriorityConfig) => {
    const newSelected = selectedPriorities.includes(priority.id)
      ? selectedPriorities.filter(p => p !== priority.id)
      : [...selectedPriorities, priority.id]
    
    setSelectedPriorities(newSelected)
    
    // Notify parent component
    if (onChange) {
      onChange(newSelected)
    }
  }

  return (
    <section className="py-16 lg:py-24 bg-muted/30">
      <div className="container px-4 sm:px-8">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold mb-4 text-primary">
            What matters most to you right now?
          </h2>
          <p className="text-lg text-muted-foreground mb-8">
            Select one or more priorities to see which levers matter most for your goals
          </p>
          
          <div className="flex flex-wrap gap-3 justify-center">
            {PRIORITIES.map((priority) => {
              const isSelected = selectedPriorities.includes(priority.id)
              
              return (
                <Button
                  key={priority.id}
                  onClick={() => handlePriorityClick(priority)}
                  variant={isSelected ? "default" : "outline"}
                  size="lg"
                  className={cn(
                    "rounded-full px-6 py-2.5 text-base font-medium transition-all",
                    isSelected && "shadow-md"
                  )}
                >
                  {priority.label}
                </Button>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
