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
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl lg:text-6xl mb-6">
            <span className="block text-[#60a5fa] leading-tight text-balance">LifestyleAcademy</span>
          </h1>
          <p className="text-lg sm:text-xl text-foreground mb-8 leading-relaxed">
            Sharing resources to help you lead a healthier, happier life with evidence-based lifestyle medicine.
          </p>

              {/* Personalized Message */}
              <div className="mb-8 p-4 sm:p-6 bg-primary/5 rounded-lg border">
                <h3 className="text-lg sm:text-xl font-bold text-foreground mb-4">Thanks so much for coming, Blue Ridge Mountain Rotary Club!</h3>
                <p className="text-base sm:text-lg text-foreground leading-relaxed mb-4">
                  It was great to meet y'all! I made this website for you to easily access all the resources discussed, and how to share them with your friends. I'd love to chat more!
                </p>
                <div className="flex flex-col sm:flex-row flex-wrap gap-3 justify-center">
                  <a 
                    href="#tips" 
                    className="bg-[#60a5fa] text-white px-4 py-2 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors text-center"
                  >
                    Longevity Toolkit
                  </a>
                  <a 
                    href="#resources" 
                    className="bg-[#60a5fa] text-white px-4 py-2 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors text-center"
                  >
                    Next Steps for Learning
                  </a>
                  <a 
                    href="#about" 
                    className="bg-[#60a5fa] text-white px-4 py-2 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors text-center"
                  >
                    About
                  </a>
                  <a 
                    href="https://cal.com/admissionsacademy" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="bg-[#60a5fa] text-white px-4 py-2 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors text-center"
                  >
                    Reach Out to Chat
                  </a>
                </div>
              </div>

          {/* Presentation Video Section */}
          <Card className="mb-8 sm:mb-12">
            <CardContent className="pt-4 sm:pt-6">
              <div className="rounded-lg overflow-hidden mb-4 sm:mb-6" style={{height: 'calc(56.25vw + 10px)', maxHeight: 'calc(630px + 10px)', width: '100%'}}>
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
                  className="bg-[#60a5fa] text-white px-4 sm:px-6 py-2 sm:py-3 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors inline-flex items-center justify-center w-full sm:w-auto"
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
