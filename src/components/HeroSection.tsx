import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export function HeroSection() {
  return (
    <section id="presentation" className="relative lg:py-12 py-0">
      <div className="container py-2 px-4 sm:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <Badge variant="secondary" className="mb-4">
            Health & Longevity Resource
          </Badge>
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl mb-6">
            <span className="block text-[#60a5fa] text-4xl sm:text-5xl md:text-6xl lg:text-7xl w-full max-w-full leading-tight text-balance text-wrap">LifestyleAcademy</span>
          </h1>
          <p className="text-xl text-foreground mb-8 leading-relaxed">
            Sharing resources to help you lead a healthier, happier life with evidence-based lifestyle medicine.
          </p>

              {/* Personalized Message */}
              <div className="mb-8 p-6 bg-primary/5 rounded-lg border">
                <h3 className="text-xl font-bold text-foreground mb-4">Thanks so much for coming, Blue Ridge Mountain Rotary Club!</h3>
                <p className="text-lg text-foreground leading-relaxed mb-4">
                  It was great to meet y'all! I made this website for you to easily access all the resources discussed, and how to share them with your friends. I'd love to chat more!
                </p>
                <div className="flex flex-wrap gap-3 justify-center">
                  <a 
                    href="#tips" 
                    className="bg-[#60a5fa] text-white px-4 py-2 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors"
                  >
                    Health Toolkit
                  </a>
                  <a 
                    href="#resources" 
                    className="bg-[#60a5fa] text-white px-4 py-2 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors"
                  >
                    Next Steps for Learning
                  </a>
                  <a 
                    href="#about" 
                    className="bg-[#60a5fa] text-white px-4 py-2 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors"
                  >
                    About
                  </a>
                  <a 
                    href="https://cal.com/admissionsacademy" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="bg-[#60a5fa] text-white px-4 py-2 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors"
                  >
                    Reach Out to Chat
                  </a>
                </div>
              </div>

          {/* Presentation Video Section */}
          <Card className="mb-12">
            <CardContent className="pt-6">
              <div className="aspect-video rounded-lg overflow-hidden mb-6">
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
                <a 
                  href="/transcript" 
                  className="bg-[#60a5fa] text-white px-6 py-3 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors inline-flex items-center justify-center"
                >
                  Read the Video Transcript
                </a>
              </div>
            </CardContent>
          </Card>

        </div>
      </div>
    </section>
  );
}

export default HeroSection;
