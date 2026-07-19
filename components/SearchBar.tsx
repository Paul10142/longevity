"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface SearchBarProps {
  placeholder?: string
  className?: string
}

/** Navigates to the semantic search page. Results come from claims (see /search). */
export function SearchBar({ placeholder = "Search the library…", className }: SearchBarProps) {
  const router = useRouter()
  const [q, setQ] = useState("")

  return (
    <form
      className={cn("relative", className)}
      onSubmit={(e) => {
        e.preventDefault()
        if (q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`)
      }}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="pl-9"
        aria-label="Search"
      />
    </form>
  )
}
