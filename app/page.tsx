import HeroSection from "@/components/HeroSection"
import ExecutiveTips from "@/components/ExecutiveTips"
import ResourcesSection from "@/components/ResourcesSection"
import About from "@/components/About"
import ContactSection from "@/components/ContactSection"

export default function Home() {
  return (
    <div className="min-h-screen bg-background">
      <main>
        <HeroSection />
        <ExecutiveTips />
        <ResourcesSection />
        <About />
        <ContactSection />
      </main>
    </div>
  )
}

