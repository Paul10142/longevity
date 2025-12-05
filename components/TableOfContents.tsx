"use client"

import { useState, useEffect, useRef } from "react"
import { ChevronDown, ChevronUp, Menu, X, GripVertical } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

interface Heading {
  id: string
  text: string
  level: number
}

interface TableOfContentsProps {
  content: string
  className?: string
}

export function TableOfContents({ content, className }: TableOfContentsProps) {
  const [headings, setHeadings] = useState<Heading[]>([])
  const [activeId, setActiveId] = useState<string>("")
  const [isExpanded, setIsExpanded] = useState(false)
  const [showFloatingToc, setShowFloatingToc] = useState(false)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [indicatorTop, setIndicatorTop] = useState('50vh')
  const contentRef = useRef<HTMLDivElement>(null)
  const edgeHoverRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)

  // Parse headings from markdown content
  useEffect(() => {
    const headingRegex = /^(#{2,3})\s+(.+)$/gm
    const foundHeadings: Heading[] = []
    let match

    while ((match = headingRegex.exec(content)) !== null) {
      const level = match[1].length // 2 for H2, 3 for H3
      const text = match[2].trim()
      const id = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .trim()

      foundHeadings.push({ id, text, level })
    }

    setHeadings(foundHeadings)
  }, [content])

  // Add IDs to headings in the DOM after ReactMarkdown renders
  useEffect(() => {
    // Use a small delay to ensure ReactMarkdown has rendered
    const timer = setTimeout(() => {
      const headingElements = document.querySelectorAll(".markdown-content h2, .markdown-content h3")
      headingElements.forEach((heading, index) => {
        if (headings[index] && !heading.id) {
          heading.id = headings[index].id
        }
      })
    }, 100)

    return () => clearTimeout(timer)
  }, [content, headings])

  // Scroll spy - highlight active section
  useEffect(() => {
    if (headings.length === 0) return

    const handleScroll = () => {
      const scrollPosition = window.scrollY + 100 // Offset for header

      for (let i = headings.length - 1; i >= 0; i--) {
        const element = document.getElementById(headings[i].id)
        if (element) {
          const elementTop = element.offsetTop
          if (scrollPosition >= elementTop) {
            setActiveId(headings[i].id)
            return
          }
        }
      }
      setActiveId("")
    }

    window.addEventListener("scroll", handleScroll)
    handleScroll() // Initial check

    return () => window.removeEventListener("scroll", handleScroll)
  }, [headings])

  // Keep indicator in viewport bounds
  useEffect(() => {
    const updateIndicatorPosition = () => {
      if (window.innerWidth < 768) return // Disable on mobile
      
      const indicator = indicatorRef.current
      if (!indicator) return

      const viewportHeight = window.innerHeight
      const indicatorHeight = indicator.offsetHeight
      const minTop = 100 // Minimum distance from top
      const maxTop = viewportHeight - indicatorHeight - 100 // Minimum distance from bottom
      
      // Calculate desired position (center of viewport)
      const desiredTop = viewportHeight / 2
      
      // Clamp to viewport bounds
      const clampedTop = Math.max(minTop, Math.min(desiredTop, maxTop))
      
      setIndicatorTop(`${clampedTop}px`)
    }

    updateIndicatorPosition()
    window.addEventListener('scroll', updateIndicatorPosition)
    window.addEventListener('resize', updateIndicatorPosition)
    
    return () => {
      window.removeEventListener('scroll', updateIndicatorPosition)
      window.removeEventListener('resize', updateIndicatorPosition)
    }
  }, [])

  // Handle hover for floating TOC - only show when hovering over indicator or TOC itself
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (window.innerWidth < 768) return // Disable on mobile

      // Check if mouse is over the floating TOC itself
      const floatingToc = document.querySelector('[data-floating-toc]')
      if (floatingToc) {
        const rect = floatingToc.getBoundingClientRect()
        const isOverToc = 
          e.clientX >= rect.left - 20 && // Add padding to prevent disappearing
          e.clientX <= rect.right + 20 &&
          e.clientY >= rect.top - 20 &&
          e.clientY <= rect.bottom + 20
        
        if (isOverToc) {
          setShowFloatingToc(true)
          return
        }
      }

      // Check if mouse is over the edge indicator
      const edgeIndicator = document.querySelector('[data-edge-indicator]')
      if (edgeIndicator) {
        const rect = edgeIndicator.getBoundingClientRect()
        const isOverIndicator = 
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        
        if (isOverIndicator) {
          setShowFloatingToc(true)
          return
        }
      }

      // If not over indicator or TOC, hide it
      setShowFloatingToc(false)
    }

    window.addEventListener("mousemove", handleMouseMove)
    return () => window.removeEventListener("mousemove", handleMouseMove)
  }, [showFloatingToc])

  const scrollToHeading = (id: string) => {
    const element = document.getElementById(id)
    if (element) {
      const offset = 120 // Increased padding above scroll destination for better spacing
      const elementPosition = element.getBoundingClientRect().top
      const offsetPosition = elementPosition + window.pageYOffset - offset

      window.scrollTo({
        top: offsetPosition,
        behavior: "smooth",
      })

      // Update active ID immediately
      setActiveId(id)
      setIsMobileMenuOpen(false)
    }
  }

  if (headings.length === 0) {
    return null
  }

  const renderTocItems = () => (
    <nav className="space-y-1">
      {headings.map((heading) => (
        <button
          key={heading.id}
          onClick={() => scrollToHeading(heading.id)}
          className={cn(
            "block w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors",
            "hover:bg-muted/50 hover:text-black",
            heading.level === 3 && "pl-6 text-xs",
            activeId === heading.id
              ? "bg-primary/10 text-primary font-medium"
              : "text-black"
          )}
        >
          {heading.text}
        </button>
      ))}
    </nav>
  )

  return (
    <>
      {/* Desktop: Collapsible TOC at top */}
      <div className={cn("mb-6", className)}>
        <div className="border rounded-lg bg-card">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors rounded-t-lg text-black"
          >
            <span>Table of Contents</span>
            {isExpanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
          {isExpanded && (
            <div className="px-2 py-3 border-t max-h-[400px] overflow-y-auto">
              {renderTocItems()}
            </div>
          )}
        </div>
      </div>

      {/* Mobile: Hamburger menu */}
      <div className="md:hidden mb-4">
        <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" className="w-full">
              <Menu className="mr-2 h-4 w-4" />
              Table of Contents
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[300px] sm:w-[400px]">
            <SheetHeader>
              <SheetTitle>Table of Contents</SheetTitle>
            </SheetHeader>
            <div className="mt-6">{renderTocItems()}</div>
          </SheetContent>
        </Sheet>
      </div>

      {/* Desktop: Right edge indicator (grip icon) */}
      <div
        ref={indicatorRef}
        data-edge-indicator
        className="hidden md:block fixed right-0 z-40 w-8 flex items-center justify-center group cursor-pointer"
        style={{
          top: indicatorTop,
          transform: 'translateY(-50%)',
        }}
        onMouseEnter={() => setShowFloatingToc(true)}
        onMouseLeave={(e) => {
          // Only hide if not moving to the floating TOC
          const floatingToc = document.querySelector('[data-floating-toc]')
          if (!floatingToc) {
            setShowFloatingToc(false)
          }
        }}
      >
        <GripVertical className="w-5 h-8 text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors" />
      </div>

      {/* Desktop: Floating TOC on right edge hover */}
      {showFloatingToc && (
        <div
          ref={edgeHoverRef}
          data-floating-toc
          className="hidden md:block fixed right-4 z-50 w-64 max-h-[80vh] overflow-y-auto bg-card border rounded-lg shadow-lg p-4"
          style={{
            top: indicatorTop,
            transform: 'translateY(-50%)',
          }}
          onMouseEnter={() => setShowFloatingToc(true)}
          onMouseLeave={() => setShowFloatingToc(false)}
        >
          {renderTocItems()}
        </div>
      )}
    </>
  )
}
