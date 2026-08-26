"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronDown, Menu } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { SearchBar } from "@/components/SearchBar"
import { cn } from "@/lib/utils"

// What every visitor sees. The site is public and patients may land on it, so
// this stays a single landing page until the rest is ready to be shown.
const publicNav = [
  { name: "Resources", href: "#resources" },
  { name: "About", href: "#about" },
] as const

// Shown only to a signed-in admin. These point at the unreleased product; the
// middleware gates the routes themselves, so this only controls whether the
// entry points are visible — the two must be released together.
const previewNav = [
  { name: "Medical Library", href: "/topics" },
  { name: "Search", href: "/search" },
] as const

// The Admin hover menu. One flat list of the main admin destinations so the
// header stays identical on public and admin pages.
const adminMenu = [
  { name: "Catalogue", href: "/admin/catalogue" },
  { name: "Sources", href: "/admin/sources" },
  { name: "Topics", href: "/admin/topics" },
  { name: "Merge Reviews", href: "/admin/reviews" },
  { name: "Insights", href: "/admin/insights/review" },
] as const

type Pillar = {
  name: string
  slug: string
  childCount: number
  children: { name: string; slug: string }[]
}

export function Header() {
  const [isOpen, setIsOpen] = useState(false)
  const [isMounted, setIsMounted] = useState(false)
  const [pillars, setPillars] = useState<Pillar[]>([])
  const [showAdmin, setShowAdmin] = useState(false)
  const pathname = usePathname()

  useEffect(() => {
    setIsMounted(true)
  }, [])

  // Only surface the Admin menu to an authenticated admin. Middleware is the real
  // gate; this just keeps the entry point hidden from ordinary visitors.
  useEffect(() => {
    let cancelled = false
    fetch("/api/admin/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { authed: false }))
      .then((d) => {
        if (!cancelled) setShowAdmin(Boolean(d.authed))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pathname])

  // Topic tree for the Medical Library mega-menu. Only fetched once an admin
  // session is confirmed: the menu is hidden from visitors, so requesting the
  // topic list for them would leak the shape of an unreleased product.
  useEffect(() => {
    if (!showAdmin) { setPillars([]); return }
    let cancelled = false
    fetch("/api/topics/nav", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { pillars: [] }))
      .then((d) => {
        if (!cancelled) setPillars(d.pillars || [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [showAdmin])

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

  const handleLogout = async () => {
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => {})
    setShowAdmin(false)
    window.location.assign("/")
  }

  const navLinkClass =
    "text-sm font-medium text-muted-foreground hover:text-primary transition-all duration-200 relative group inline-flex items-center"
  const underlineClass =
    "absolute bottom-0 left-0 w-0 h-0.5 bg-accent group-hover:w-full transition-all duration-300"

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60 shadow-sm">
      <div className="container relative flex h-20 items-center justify-between gap-4">
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
        <div className="hidden md:flex items-center gap-6">
          <nav className="flex items-center gap-6">
            {[...(showAdmin ? previewNav : []), ...publicNav].map((item) =>
              item.href === "/topics" && pillars.length > 0 ? (
                <div key={item.name} className="group">
                  <Link href={item.href} className={cn(navLinkClass, "gap-0.5 pr-0.5")}>
                    {item.name}
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
                    <span className={underlineClass} />
                  </Link>
                  <div
                    className="absolute right-0 top-full pt-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible z-50 transition-[opacity,visibility] duration-150"
                    role="menu"
                  >
                    <div className="rounded-lg border border-border/60 bg-popover text-popover-foreground shadow-lg p-5 w-[780px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto">
                      <div className="grid grid-cols-3 gap-x-6 gap-y-5">
                        {pillars.map((p) => (
                          <div key={p.slug} className="min-w-0">
                            <Link
                              href={`/topics/${p.slug}`}
                              className="block text-sm font-semibold text-foreground hover:text-primary"
                              role="menuitem"
                            >
                              {p.name}
                            </Link>
                            <ul className="mt-1.5 space-y-1">
                              {p.children.map((c) => (
                                <li key={c.slug}>
                                  <Link
                                    href={`/topics/${c.slug}`}
                                    className="block text-sm text-muted-foreground hover:text-foreground truncate"
                                    role="menuitem"
                                  >
                                    {c.name}
                                  </Link>
                                </li>
                              ))}
                              {p.childCount > p.children.length && (
                                <li>
                                  <Link
                                    href={`/topics/${p.slug}`}
                                    className="block text-xs text-primary/80 hover:text-primary"
                                    role="menuitem"
                                  >
                                    All {p.name} →
                                  </Link>
                                </li>
                              )}
                            </ul>
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 pt-3 border-t border-border/40">
                        <Link
                          href="/topics"
                          className="text-sm font-medium text-primary hover:underline"
                          role="menuitem"
                        >
                          Explore all topics →
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              ) : item.href.startsWith("#") ? (
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
          </nav>

          {/* Search reads the unreleased library, so it is hidden with it. */}
          {showAdmin && <SearchBar className="w-56" />}

          {/* Signed out this is a plain "Login" link with no menu: a patient
              should see one unremarkable word, not a dropdown of internal
              tools. Signed in it becomes the Admin menu. showAdmin defaults to
              false and is confirmed by a fetch, so the closed state renders
              first — the safe way round. */}
          {showAdmin ? (
            <div className="relative group">
              <Link href="/admin" className={cn(navLinkClass, "gap-0.5 pr-0.5")}>
                Admin
                <ChevronDown className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
                <span className={underlineClass} />
              </Link>
              <div
                className="absolute right-0 top-full pt-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible z-50 min-w-[11rem] transition-[opacity,visibility] duration-150"
                role="menu"
              >
                <div className="rounded-md border border-border/60 bg-popover text-popover-foreground shadow-md py-1">
                  {adminMenu.map((sub) => (
                    <Link
                      key={sub.href}
                      href={sub.href}
                      className="block px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                      role="menuitem"
                    >
                      {sub.name}
                    </Link>
                  ))}
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="block w-full text-left px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground border-t border-border/40 mt-1"
                    role="menuitem"
                  >
                    Log out
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <Link href="/admin/login" className={navLinkClass}>
              Login
              <span className={underlineClass} />
            </Link>
          )}
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
                {[...(showAdmin ? previewNav : []), ...publicNav].map((item) =>
                  item.href === "/topics" && pillars.length > 0 ? (
                    <div key={item.name} className="border-b border-border/40 pb-2">
                      <Link
                        href={item.href}
                        className="block text-lg font-medium text-muted-foreground hover:text-primary transition-colors py-2"
                        onClick={() => setIsOpen(false)}
                      >
                        {item.name}
                      </Link>
                      <div className="flex flex-col">
                        {pillars.map((p) => (
                          <Link
                            key={p.slug}
                            href={`/topics/${p.slug}`}
                            className="text-base text-muted-foreground hover:text-primary transition-colors py-1.5 pl-3"
                            onClick={() => setIsOpen(false)}
                          >
                            {p.name}
                          </Link>
                        ))}
                      </div>
                    </div>
                  ) : item.href.startsWith("#") ? (
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

                {showAdmin && (
                  <div className="pb-4 border-b border-border/40">
                    <SearchBar />
                  </div>
                )}

                {/* Mirrors the desktop rule: one plain "Login" link when
                    signed out, the tool list only once signed in. */}
                {showAdmin ? (
                  <div>
                    <Link
                      href="/admin"
                      onClick={() => setIsOpen(false)}
                      className="block text-lg font-medium text-muted-foreground hover:text-primary transition-colors py-2"
                    >
                      Admin
                    </Link>
                    <div className="flex flex-col">
                      {adminMenu.map((sub) => (
                        <Link
                          key={sub.href}
                          href={sub.href}
                          className="text-base text-muted-foreground hover:text-primary transition-colors py-1.5 pl-3"
                          onClick={() => setIsOpen(false)}
                        >
                          {sub.name}
                        </Link>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          setIsOpen(false)
                          handleLogout()
                        }}
                        className="text-base text-muted-foreground hover:text-primary transition-colors py-1.5 pl-3 text-left"
                      >
                        Log out
                      </button>
                    </div>
                  </div>
                ) : (
                  <Link
                    href="/admin/login"
                    onClick={() => setIsOpen(false)}
                    className="block text-lg font-medium text-muted-foreground hover:text-primary transition-colors py-2"
                  >
                    Login
                  </Link>
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
