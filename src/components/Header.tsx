import { useState } from "react";
import { Menu, X as LucideX, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

const navigation = [
  { name: "Presentation", href: "#presentation" },
  { name: "Executive Tips", href: "#tips" },
  { name: "Resources", href: "#resources" },
  { name: "Contact", href: "#contact" },
];

const HEADER_HEIGHT = 64; // px

interface HeaderProps {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  matchCount: number;
  currentIndex: number;
  nextMatch: () => void;
  prevMatch: () => void;
}

export function Header({ searchQuery, setSearchQuery, matchCount, currentIndex, nextMatch, prevMatch }: HeaderProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleNavigation = (href: string) => {
    if (href.startsWith("#")) {
      const scrollToElement = () => {
        const element = document.querySelector(href);
        if (element) {
          const y = element.getBoundingClientRect().top + window.pageYOffset - HEADER_HEIGHT;
          window.scrollTo({ top: y, behavior: "smooth" });
        }
      };
      scrollToElement();
    }
    setIsOpen(false);
  };

  const handleLogoClick = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <>
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <button 
            onClick={handleLogoClick}
            className="flex items-center space-x-4 hover:opacity-80 transition-opacity"
          >
            <div className="h-8 w-8 bg-[#60a5fa] rounded-full flex items-center justify-center">
              <span className="text-white font-bold text-sm">L</span>
            </div>
            <div className="flex flex-col">
              <span className="text-xl font-bold text-[#60a5fa]">Longevity Leadership</span>
            </div>
          </button>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center space-x-6">
            {navigation.map((item) => (
              <button
                key={item.name}
                onClick={() => handleNavigation(item.href)}
                className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
              >
                {item.name}
              </button>
            ))}
          </nav>

          {/* Search (Desktop) */}
          <div className="hidden md:flex items-center space-x-4">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search..."
                className="pl-8 w-64 pr-8"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                aria-label="Search site content"
              />
              {searchQuery && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  aria-label="Clear search"
                  tabIndex={0}
                >
                  <LucideX className="h-4 w-4 text-muted-foreground" />
                </Button>
              )}
              {searchQuery && (
                <div className="absolute right-0 mt-1 flex items-center space-x-2 bg-background/95 rounded shadow px-2 py-1 border text-xs text-muted-foreground" style={{ top: 'calc(100% + 2px)' }}>
                  <span>{matchCount} match{matchCount === 1 ? "" : "es"}</span>
                  <Button variant="ghost" size="icon" onClick={prevMatch} disabled={matchCount === 0} aria-label="Previous match">
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={nextMatch} disabled={matchCount === 0} aria-label="Next match">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <span>{matchCount > 0 ? `${currentIndex + 1} of ${matchCount}` : null}</span>
                </div>
              )}
            </div>
          </div>

          {/* Mobile Navigation */}
          <Sheet open={isOpen} onOpenChange={setIsOpen}>
            <SheetTrigger asChild className="md:hidden">
              <Button variant="ghost" size="icon">
                <Menu className="h-8 w-8" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[300px] sm:w-[400px]">
              <nav className="flex flex-col space-y-4 mt-1">
                {navigation.map((item) => (
                  <button
                    key={item.name}
                    onClick={() => handleNavigation(item.href)}
                    className="text-lg font-medium text-muted-foreground hover:text-primary transition-colors text-left ml-1"
                  >
                    {item.name}
                  </button>
                ))}
              </nav>
              <div className="mt-6">
                <div className="relative">
                  <Input
                    placeholder="Search..."
                    className="w-full pr-10" // add right padding for icon
                    style={{ fontSize: 16 }} // prevent iOS zoom
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    aria-label="Search site content"
                    onFocus={e => e.target.scrollIntoView({ block: "nearest", behavior: "instant" })}
                  />
                  {!searchQuery && (
                    <Search className="absolute right-2 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
                  )}
                  {searchQuery && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setSearchQuery("")}
                      className="absolute right-1 top-1/2 -translate-y-1/2"
                      aria-label="Clear search"
                      tabIndex={0}
                    >
                      <LucideX className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  )}
                </div>
                {searchQuery && (
                  <div className="flex items-center space-x-2 bg-background/95 rounded shadow px-2 py-1 border text-xs text-muted-foreground mt-2 w-full justify-center">
                    <span>{matchCount} match{matchCount === 1 ? "" : "es"}</span>
                    <Button variant="ghost" size="icon" onClick={prevMatch} disabled={matchCount === 0} aria-label="Previous match">
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={nextMatch} disabled={matchCount === 0} aria-label="Next match">
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <span>{matchCount > 0 ? `${currentIndex + 1} of ${matchCount}` : null}</span>
                  </div>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </header>
    </>
  );
}

export default Header;
