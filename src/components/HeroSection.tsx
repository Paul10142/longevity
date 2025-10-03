import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useEffect } from "react";

export function HeroSection() {
  useEffect(() => {
    // Load Tally form after component mounts
    const loadTallyForm = () => {
      const d = document;
      const w = "https://tally.so/widgets/embed.js";
      const v = function() {
        if (typeof (window as any).Tally !== "undefined") {
          (window as any).Tally.loadEmbeds();
        } else {
          d.querySelectorAll("iframe[data-tally-src]:not([src])").forEach((e: any) => {
            e.src = e.dataset.tallySrc;
          });
        }
      };
      
      if (typeof (window as any).Tally !== "undefined") {
        v();
      } else if (d.querySelector('script[src="' + w + '"]') === null) {
        const s = d.createElement("script");
        s.src = w;
        s.onload = v;
        s.onerror = v;
        d.body.appendChild(s);
      }
    };

    // Small delay to ensure DOM is ready
    const timer = setTimeout(loadTallyForm, 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <section id="presentation" className="relative lg:py-12 py-0">
      <div className="container py-2 px-4 sm:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <Badge variant="secondary" className="mb-4">
            Health & Longevity Resource
          </Badge>
          <h1 className="text-4xl font-bold tracking-tight sm:text-4xl md:text-5xl lg:text-6xl mb-6">
            <span className="block text-[#60a5fa] leading-tight text-balance">
              <span className="block sm:inline">Lifestyle</span>
              <span className="block sm:inline">Academy</span>
            </span>
          </h1>
          <p className="text-lg sm:text-xl text-foreground mb-8 leading-relaxed">
            Sharing resources to help you lead a healthier, happier life with evidence-based lifestyle medicine.
          </p>

              {/* Personalized Message */}
              <div className="mb-8 p-4 sm:p-6 bg-primary/5 rounded-lg border">
                <h3 className="text-lg sm:text-xl font-bold text-foreground mb-4">Thanks so much for coming, Blue Ridge Mountain Rotary Club!</h3>
                <p className="text-base sm:text-lg text-foreground leading-relaxed mb-4">
                  It was great to meet y'all! I made this website for you to easily access all the resources discussed and be able to shared with loved ones!
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
          <Card className="mb-0">
            <CardContent className="pt-4 sm:pt-6 pb-0">
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

          {/* Embedded Form */}
          <div className="mb-8 sm:mb-12" style={{ marginTop: '50px' }}>
            <div className="rounded-lg overflow-hidden">
              <iframe 
                data-tally-src="https://tally.so/embed/n9VLp5?alignLeft=1&hideTitle=1&transparentBackground=1" 
                loading="lazy" 
                width="100%" 
                height="552" 
                frameBorder="0" 
                marginHeight={0} 
                marginWidth={0} 
                title="LifestyleAcademy - F/U"
                className="rounded-lg border-0 outline-none"
                style={{ border: 'none', outline: 'none' }}
              ></iframe>
            </div>
          </div>

        </div>
      </div>
    </section>
  );
}

export default HeroSection;
