"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { SearchBar } from "@/components/SearchBar"

  const navigation = [
    { name: "Topics", href: "/topics" },
    { name: "Insights", href: "/admin/insights/review" },
    { name: "Sources", href: "/admin/sources" },
    { name: "Longevity Toolkit", href: "#tips" },
    { name: "About", href: "#about" },
  ]

export function Header() {
  const [isOpen, setIsOpen] = useState(false)
  const [isMounted, setIsMounted] = useState(false)
  const pathname = usePathname()

  // Only render Sheet on client to avoid hydration mismatch
  useEffect(() => {
    setIsMounted(true)
  }, [])

  const handleNavigation = (href: string) => {
    if (href.startsWith("#")) {
      // If we're on a different page, navigate to homepage first
      if (pathname !== "/") {
        window.location.href = `/${href}`
      } else {
        // We're already on homepage, just scroll to the section
        const scrollToElement = () => {
          const element = document.querySelector(href)
          if (element) {
            const isMobile = window.innerWidth < 768
            const offset = isMobile ? 90 : 50
            const y = element.getBoundingClientRect().top + window.pageYOffset - offset
            window.scrollTo({ top: y, behavior: "smooth" })
          }
        }
        scrollToElement()
      }
    }
    setIsOpen(false)
  }

  const handleLogoClick = () => {
    window.location.href = "/"
  }

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60 shadow-sm">
      <div className="container flex h-20 items-center justify-between">
        <button 
          onClick={handleLogoClick}
          className="flex items-center space-x-3 hover:opacity-80 transition-all duration-300 group"
        >
          <span className="text-[2.1rem]">❤️</span>
          <div className="flex flex-col">
            <span className="text-xl font-sans font-semibold text-primary tracking-tight">LifestyleAcademy</span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Live Healthier & Happier</span>
          </div>
        </button>

        {/* Desktop Navigation */}
        <nav className="hidden md:flex items-center space-x-8">
          {navigation.map((item) =>
            item.href.startsWith("#") ? (
              <button
                key={item.name}
                onClick={() => handleNavigation(item.href)}
                className="text-sm font-medium text-muted-foreground hover:text-primary transition-all duration-200 relative group"
              >
                {item.name}
                <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-accent group-hover:w-full transition-all duration-300"></span>
              </button>
            ) : (
              <Link
                key={item.name}
                href={item.href}
                className="text-sm font-medium text-muted-foreground hover:text-primary transition-all duration-200 relative group"
              >
                {item.name}
                <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-accent group-hover:w-full transition-all duration-300"></span>
              </Link>
            )
          )}
          <div className="flex items-center gap-3 ml-4">
            <SearchBar className="w-64" />
            <Link href="/start">
              <Button size="sm">
                Start Here
              </Button>
            </Link>
          </div>
        </nav>

        {/* Mobile Navigation */}
        {isMounted ? (
          <Sheet open={isOpen} onOpenChange={setIsOpen}>
            <SheetTrigger asChild className="md:hidden">
              <Button variant="ghost" size="icon" className="h-10 w-10">
                <Menu className="h-6 w-6" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[300px] sm:w-[400px] bg-background/95 backdrop-blur-md">
              <SheetTitle className="sr-only">Navigation Menu</SheetTitle>
              <nav className="flex flex-col space-y-6 mt-8">
                {/* Search bar for mobile */}
                <div className="pb-4 border-b border-border/40">
                  <SearchBar />
                </div>
                {navigation.map((item) =>
                  item.href.startsWith("#") ? (
                    <button
                      key={item.name}
                      onClick={() => handleNavigation(item.href)}
                      className="text-lg font-medium text-muted-foreground hover:text-primary transition-colors text-left py-2 border-b border-border/40"
                    >
                      {item.name}
                    </button>
                  ) : (
                    <Link
                      key={item.name}
                      href={item.href}
                      className="text-lg font-medium text-muted-foreground hover:text-primary transition-colors text-left py-2 border-b border-border/40"
                      onClick={() => setIsOpen(false)}
                    >
                      {item.name}
                    </Link>
                  )
                )}
                <Link
                  href="/start"
                  onClick={() => setIsOpen(false)}
                  className="mt-4"
                >
                  <Button className="w-full">
                    Start Here
                  </Button>
                </Link>
              </nav>
            </SheetContent>
          </Sheet>
        ) : (
          // Fallback button during SSR to prevent layout shift
          <Button variant="ghost" size="icon" className="h-10 w-10 md:hidden" disabled>
            <Menu className="h-6 w-6" />
          </Button>
        )}
      </div>
    </header>
  )
}

export default Header

