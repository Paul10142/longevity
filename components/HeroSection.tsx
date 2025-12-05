import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { ArrowRight } from "lucide-react"

export function HeroSection() {

  return (
    <section id="presentation" className="relative py-16 lg:py-24">
      <div className="absolute inset-0 bg-gradient-to-b from-background via-background to-muted/20"></div>
      <div className="container relative py-8 px-4 sm:px-8">
        <div className="mx-auto max-w-5xl text-center">
          <Badge variant="secondary" className="mb-6 px-4 py-1.5 text-xs font-medium tracking-wider uppercase border border-border/50 bg-muted/50">
            Evidence-Based Health & Longevity
          </Badge>
          <h1 className="text-5xl font-sans font-semibold tracking-tight sm:text-6xl md:text-7xl lg:text-8xl mb-8 leading-[1.1]">
            <span className="block text-primary leading-tight text-balance">
              <span className="block sm:inline">Lifestyle</span>
              <span className="block sm:inline">Academy</span>
            </span>
          </h1>
          <p className="text-xl sm:text-2xl text-muted-foreground mb-12 leading-relaxed max-w-3xl mx-auto font-light">
            Empowering you with evidence-based strategies to optimize your health and wellness, 
            helping you lead a healthier, happier life through lifestyle medicine.
          </p>

          {/* Navigation Links */}
          <div className="mb-16 flex flex-col sm:flex-row flex-wrap gap-4 justify-center">
            <a 
              href="#tips" 
              className="group relative bg-primary text-primary-foreground px-8 py-3.5 rounded-md font-semibold hover:bg-primary/90 transition-all duration-300 text-center shadow-premium hover:shadow-premium-lg transform hover:-translate-y-0.5"
            >
              Longevity Toolkit
              <ArrowRight className="inline-block ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
            </a>
            <a 
              href="#resources" 
              className="group relative bg-primary text-primary-foreground px-8 py-3.5 rounded-md font-semibold hover:bg-primary/90 transition-all duration-300 text-center shadow-premium hover:shadow-premium-lg transform hover:-translate-y-0.5"
            >
              Learning Resources
              <ArrowRight className="inline-block ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
            </a>
            <a 
              href="#about" 
              className="group relative border-2 border-primary text-primary px-8 py-3.5 rounded-md font-semibold hover:bg-primary hover:text-primary-foreground transition-all duration-300 text-center"
            >
              About Us
            </a>
            <a 
              href="https://cal.com/admissionsacademy" 
              target="_blank" 
              rel="noopener noreferrer"
              className="group relative bg-accent text-accent-foreground px-8 py-3.5 rounded-md font-semibold hover:bg-accent/90 transition-all duration-300 text-center shadow-premium hover:shadow-premium-lg transform hover:-translate-y-0.5"
            >
              Schedule a Consultation
              <ArrowRight className="inline-block ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
            </a>
          </div>

          {/* Presentation Video Section */}
          <Card className="mb-0 border-2 border-border/50 shadow-premium-lg overflow-hidden">
            <CardContent className="pt-8 sm:pt-10 pb-8">
              <div className="rounded-lg overflow-hidden mb-8 shadow-lg" style={{height: 'calc(56.25vw + 10px)', maxHeight: 'calc(630px + 10px)', width: '100%'}}>
                <iframe
                  width="100%"
                  height="100%"
                  src="https://www.youtube.com/embed/FYgbOwHlk3M"
                  title="Lifestyle Medicine: The Most Important Talk of Your Life"
                  frameBorder="0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                  className="rounded-lg"
                ></iframe>
              </div>
              
              <div className="text-center">
                <Link 
                  href="/transcript" 
                  className="group inline-flex items-center justify-center bg-primary text-primary-foreground px-8 py-3.5 rounded-md font-semibold hover:bg-primary/90 transition-all duration-300 shadow-premium hover:shadow-premium-lg transform hover:-translate-y-0.5"
                >
                  Read the Video Transcript
                  <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
                </Link>
              </div>
            </CardContent>
          </Card>

        </div>
      </div>
    </section>
  );
}

export default HeroSection;
