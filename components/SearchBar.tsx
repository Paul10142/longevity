"use client"

import { useState, useEffect, useRef } from "react"
import { Search, Loader2, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import { cn } from "@/lib/utils"
import type { SearchResult } from "@/lib/search"

interface SearchBarProps {
  conceptId?: string // If provided, limits search to this concept
  conceptSlug?: string // For linking to topic pages
  placeholder?: string
  className?: string
}

export function SearchBar({ conceptId, conceptSlug, placeholder = "Search insights...", className }: SearchBarProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const searchRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setSelectedIndex(-1)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  // Handle search
  const handleSearch = async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults([])
      setIsOpen(false)
      return
    }

    setIsSearching(true)
    setIsOpen(true)

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery, conceptId }),
      })

      if (!response.ok) {
        throw new Error("Search failed")
      }

      const data = await response.json()
      setResults(data.results || [])
      setSelectedIndex(-1)
    } catch (error) {
      console.error("Search error:", error)
      setResults([])
    } finally {
      setIsSearching(false)
    }
  }

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query) {
        handleSearch(query)
      } else {
        setResults([])
        setIsOpen(false)
      }
    }, 300) // 300ms debounce

    return () => clearTimeout(timer)
  }, [query])

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || results.length === 0) return

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setSelectedIndex((prev) => (prev < results.length - 1 ? prev + 1 : prev))
        break
      case "ArrowUp":
        e.preventDefault()
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1))
        break
      case "Enter":
        e.preventDefault()
        if (selectedIndex >= 0 && results[selectedIndex]) {
          // Navigate to result (would need to implement navigation)
          setIsOpen(false)
        }
        break
      case "Escape":
        setIsOpen(false)
        setSelectedIndex(-1)
        break
    }
  }

  const formatEvidenceType = (type: string): string => {
    if (type === 'RCT') return 'RCT'
    if (type === 'MetaAnalysis') return 'Meta-Analysis'
    const spaced = type.replace(/([a-z])([A-Z])/g, '$1 $2')
    return spaced.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ')
  }

  return (
    <div ref={searchRef} className={cn("relative", className)}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (results.length > 0) setIsOpen(true)
          }}
          className="pl-10 pr-10 w-full"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 transform -translate-y-1/2 h-7 w-7"
            onClick={() => {
              setQuery("")
              setResults([])
              setIsOpen(false)
              inputRef.current?.focus()
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
        {isSearching && (
          <Loader2 className="absolute right-10 top-1/2 transform -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Dropdown Results */}
      {isOpen && (query || results.length > 0) && (
        <Card className="absolute z-50 w-full mt-2 max-h-[500px] overflow-y-auto shadow-lg">
          <CardContent className="p-0">
            {results.length === 0 && query && !isSearching ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                No results found
              </div>
            ) : results.length > 0 ? (
              <div className="divide-y">
                {results.map((result, index) => (
                  <Link
                    key={result.id}
                    href={conceptSlug ? `/topics/${conceptSlug}?insight=${result.id}` : `/topics?insight=${result.id}`}
                    onClick={() => {
                      setIsOpen(false)
                      setQuery("")
                    }}
                    className={cn(
                      "block p-4 hover:bg-muted/50 transition-colors",
                      index === selectedIndex && "bg-muted"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {result.importance && (
                            <div className="flex gap-0.5">
                              {[1, 2, 3].map((level) => (
                                <span
                                  key={level}
                                  className={cn(
                                    "text-xs",
                                    level <= result.importance!
                                      ? "text-primary"
                                      : "text-muted-foreground/30"
                                  )}
                                >
                                  ★
                                </span>
                              ))}
                            </div>
                          )}
                          <Badge variant="outline" className="text-xs">
                            {formatEvidenceType(result.evidence_type)}
                          </Badge>
                          {result.similarity && (
                            <Badge variant="secondary" className="text-xs">
                              {Math.round(result.similarity * 100)}% match
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm font-medium line-clamp-2">{result.statement}</p>
                        {result.source && (
                          <p className="text-xs text-muted-foreground mt-1">
                            From: {result.source.title}
                          </p>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

