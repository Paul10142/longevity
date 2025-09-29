import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Play, Download, Target, TrendingUp, Users } from "lucide-react";

export function HeroSection() {
  return (
    <section id="presentation" className="relative lg:py-12 py-0">
      <div className="container py-2 px-4 sm:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <Badge variant="secondary" className="mb-4">
            Executive Health & Longevity Resource
          </Badge>
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl mb-6">
            <span className="block text-balance text-wrap text-3xl sm:text-4xl md:text-5xl lg:text-6xl w-full max-w-full leading-tight">Welcome to</span>
            <span className="block text-[#60a5fa] text-4xl sm:text-5xl md:text-6xl lg:text-7xl w-full max-w-full leading-tight text-balance text-wrap">Longevity Leadership</span>
          </h1>
          <p className="text-xl text-foreground mb-8 leading-relaxed">
            Evidence-based strategies for executives to optimize health, performance, and longevity through lifestyle medicine.
          </p>
          
          <div className="flex flex-wrap justify-center gap-3 mb-12">
            <Badge variant="outline" className="px-3 py-1">Executive Health</Badge>
            <Badge variant="outline" className="px-3 py-1">Lifestyle Medicine</Badge>
            <Badge variant="outline" className="px-3 py-1">Performance Optimization</Badge>
          </div>

          {/* Presentation Video Section */}
          <Card className="mb-12">
            <CardContent className="pt-6">
              <div className="aspect-video bg-muted rounded-lg flex items-center justify-center mb-6">
                <div className="text-center">
                  <Play className="h-16 w-16 text-[#60a5fa] mx-auto mb-4" />
                  <p className="text-muted-foreground">Presentation Video</p>
                  <p className="text-sm text-muted-foreground">Click to play recorded presentation</p>
                </div>
              </div>
              
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Button className="bg-[#60a5fa] text-white hover:bg-[#3b82f6] transition-colors flex items-center justify-center">
                  <Play className="h-5 w-5 mr-2" />
                  Watch Presentation
                </Button>
                <Button variant="outline" className="border-[#60a5fa] text-[#60a5fa] hover:bg-[#60a5fa]/10 transition-colors flex items-center justify-center">
                  <Download className="h-5 w-5 mr-2" />
                  Download Slides
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Feature Cards */}
          <div className="hidden md:grid md:grid-cols-3 gap-6 mt-16">
            <Card className="text-center">
              <CardContent className="pt-6">
                <Target className="h-12 w-12 text-[#60a5fa] mx-auto mb-4" />
                <h3 className="text-xl font-semibold mb-2">Performance Metrics</h3>
                <p className="text-foreground">
                  Track key biomarkers and lifestyle factors that directly impact your cognitive and physical performance
                </p>
              </CardContent>
            </Card>
            
            <Card className="text-center">
              <CardContent className="pt-6">
                <TrendingUp className="h-12 w-12 text-[#60a5fa] mx-auto mb-4" />
                <h3 className="text-xl font-semibold mb-2">Evidence-Based</h3>
                <p className="text-foreground">
                  Based on research from Peter Attia's "Outlive" and other longevity science leaders
                </p>
              </CardContent>
            </Card>
            
            <Card className="text-center">
              <CardContent className="pt-6">
                <Users className="h-12 w-12 text-[#60a5fa] mx-auto mb-4" />
                <h3 className="text-xl font-semibold mb-2">Executive Focus</h3>
                <p className="text-foreground">
                  Tailored strategies for busy executives who want to optimize health without sacrificing productivity
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </section>
  );
}

export default HeroSection;
