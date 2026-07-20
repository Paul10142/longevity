"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronDown, Menu } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { SearchBar } from "@/components/SearchBar"
import { cn } from "@/lib/utils"

const publicNav = [
  { name: "Medical Library", href: "/topics" },
  { name: "Search", href: "/search" },
  { name: "Resources", href: "#resources" },
  { name: "About", href: "#about" },
] as const

const adminNavLinks = [
  { name: "Sources", href: "/admin/sources" },
  { name: "Topics", href: "/admin/topics" },
  { name: "Merge Reviews", href: "/admin/reviews" },
] as const

const insightSubLinks = [
  { name: "Review", href: "/admin/insights/review" },
  { name: "Merge Reviews", href: "/admin/reviews" },
] as const

export function Header() {
  const [isOpen, setIsOpen] = useState(false)
  const [isMounted, setIsMounted] = useState(false)
  const pathname = usePathname()
  const isAdmin = pathname.startsWith("/admin")

  useEffect(() => {
    setIsMounted(true)
  }, [])

  const handleNavigation = (href: string) => {
    if (href.startsWith("#")) {
      if (pathname !== "/") {
        window.location.href = `/${href}`
      } else {
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

  const navLinkClass =
    "text-sm font-medium text-muted-foreground hover:text-primary transition-all duration-200 relative group inline-flex items-center"
  const underlineClass =
    "absolute bottom-0 left-0 w-0 h-0.5 bg-accent group-hover:w-full transition-all duration-300"

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60 shadow-sm">
      <div className="container flex h-20 items-center justify-between">
        <button
          type="button"
          onClick={handleLogoClick}
          className="flex items-center space-x-3 hover:opacity-80 transition-all duration-300 group"
        >
          <span className="text-[2.1rem]">❤️</span>
          <div className="flex flex-col text-left">
            <span className="text-xl font-sans font-semibold text-primary tracking-tight">LifestyleAcademy</span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
              Live Healthier &amp; Happier
            </span>
          </div>
        </button>

        {/* Desktop */}
        <div className="hidden md:flex items-center gap-8">
          <nav className="flex items-center gap-8">
            {!isAdmin &&
              publicNav.map((item) =>
                item.href.startsWith("#") ? (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => handleNavigation(item.href)}
                    className={navLinkClass}
                  >
                    {item.name}
                    <span className={underlineClass} />
                  </button>
                ) : (
                  <Link key={item.name} href={item.href} className={navLinkClass}>
                    {item.name}
                    <span className={underlineClass} />
                  </Link>
                )
              )}

            {isAdmin && (
              <>
                {adminNavLinks.map((item) => (
                  <Link key={item.href} href={item.href} className={navLinkClass}>
                    {item.name}
                    <span className={underlineClass} />
                  </Link>
                ))}
                <div className="relative group">
                  <Link
                    href="/admin/insights/review"
                    className={cn(navLinkClass, "gap-0.5 pr-0.5")}
                  >
                    Insights
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
                    <span className={underlineClass} />
                  </Link>
                  <div
                    className="absolute left-0 top-full pt-1 opacity-0 invisible group-hover:opacity-100 group-hover:visible z-50 min-w-[11rem] transition-[opacity,visibility] duration-150"
                    role="menu"
                  >
                    <div className="rounded-md border border-border/60 bg-popover text-popover-foreground shadow-md py-1">
                      {insightSubLinks.map((sub) => (
                        <Link
                          key={sub.href}
                          href={sub.href}
                          className="block px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                          role="menuitem"
                        >
                          {sub.name}
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}
          </nav>
          {isAdmin && <SearchBar className="w-64" />}
        </div>

        {/* Mobile */}
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
                {!isAdmin &&
                  publicNav.map((item) =>
                    item.href.startsWith("#") ? (
                      <button
                        key={item.name}
                        type="button"
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

                {isAdmin && (
                  <>
                    {adminNavLinks.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        className="text-lg font-medium text-muted-foreground hover:text-primary transition-colors text-left py-2 border-b border-border/40"
                        onClick={() => setIsOpen(false)}
                      >
                        {item.name}
                      </Link>
                    ))}
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-2">
                      Insights
                    </p>
                    {insightSubLinks.map((sub) => (
                      <Link
                        key={sub.href}
                        href={sub.href}
                        className="text-lg font-medium text-muted-foreground hover:text-primary transition-colors text-left py-2 border-b border-border/40 pl-2"
                        onClick={() => setIsOpen(false)}
                      >
                        {sub.name}
                      </Link>
                    ))}
                    <div className="pb-4 border-b border-border/40 pt-2">
                      <SearchBar />
                    </div>
                  </>
                )}
              </nav>
            </SheetContent>
          </Sheet>
        ) : (
          <Button variant="ghost" size="icon" className="h-10 w-10 md:hidden" disabled>
            <Menu className="h-6 w-6" />
          </Button>
        )}
      </div>
    </header>
  )
}

export default Header
