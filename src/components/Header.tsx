import { useState } from "react";
import { Link } from "react-router-dom";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

const navigation = [
  { name: "Presentation", href: "#presentation" },
  { name: "Transcript", href: "/transcript" },
  { name: "Health Toolkit", href: "#tips" },
  { name: "Resources", href: "#resources" },
  { name: "About", href: "#about" },
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

export function Header({ }: HeaderProps) {
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
    } else {
      // Handle regular navigation
      window.location.href = href;
    }
    setIsOpen(false);
  };

  const handleLogoClick = () => {
    window.location.href = "/";
  };

  return (
    <>
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <button 
            onClick={handleLogoClick}
            className="flex items-center space-x-4 hover:opacity-80 transition-opacity"
          >
            <span className="text-2xl">❤️</span>
            <div className="flex flex-col">
              <span className="text-xl font-bold text-[#60a5fa]">LifestyleAcademy</span>
            </div>
          </button>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center space-x-6">
            {navigation.map((item) => (
              item.href.startsWith("#") ? (
                <button
                  key={item.name}
                  onClick={() => handleNavigation(item.href)}
                  className="text-base font-medium text-muted-foreground hover:text-primary transition-colors"
                >
                  {item.name}
                </button>
              ) : (
                <Link
                  key={item.name}
                  to={item.href}
                  className="text-base font-medium text-muted-foreground hover:text-primary transition-colors"
                >
                  {item.name}
                </Link>
              )
            ))}
          </nav>


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
                  item.href.startsWith("#") ? (
                    <button
                      key={item.name}
                      onClick={() => handleNavigation(item.href)}
                      className="text-lg font-medium text-muted-foreground hover:text-primary transition-colors text-left ml-1"
                    >
                      {item.name}
                    </button>
                  ) : (
                    <Link
                      key={item.name}
                      to={item.href}
                      className="text-lg font-medium text-muted-foreground hover:text-primary transition-colors text-left ml-1"
                      onClick={() => setIsOpen(false)}
                    >
                      {item.name}
                    </Link>
                  )
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </header>
    </>
  );
}

export default Header;
