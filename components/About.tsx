import { Card, CardContent } from "@/components/ui/card";
import founderPhoto from "@/assets/founder-photo.jpg";
import Image from "next/image";

const About = () => {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-muted/20 to-background">
      <main className="container mx-auto px-4 pt-0 pb-0">
        {/* About Lifestyle Academy Section */}
        <section className="mb-16 sm:mb-20">
          <div className="max-w-4xl mx-auto text-center mb-12">
            <h2 className="text-4xl sm:text-5xl font-sans font-semibold tracking-tight mb-6 text-primary">About LifestyleAcademy</h2>
          </div>
          
          <div className="max-w-4xl mx-auto">
            <Card className="shadow-premium-lg border-2 border-border/50 overflow-hidden bg-gradient-to-br from-background to-muted/20">
              <CardContent className="p-8 sm:p-10 lg:p-12">
                <div className="text-lg sm:text-xl text-muted-foreground leading-relaxed space-y-6 font-light">
                  <p>
                    LifestyleAcademy was founded by Paul Clancy and brought to you by <a href="https://www.admissionsacademy.org" target="_blank" rel="noopener noreferrer" className="text-primary font-medium underline hover:text-primary/80 transition-colors">AdmissionsAcademy.org</a>, 
                    an organization committed to expanding access to educational resources for pre-health students nationwide.
                  </p>
                  
                  <p>
                    Our mission is to empower patients with evidence-based strategies for optimizing their health and wellness to help them lead healthier, happier lives. Drawing from the latest research in lifestyle medicine and insights from longevity leaders such as Peter Attia and Dr. Rhonda Patrick, we provide tools and frameworks for patients who want to become more involved in their health, learn more about the field, and live healthier lives!
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Founder Section */}
        <section id="about" className="pt-8">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-3xl sm:text-4xl font-sans font-semibold text-center text-primary mb-16">Paul Clancy MD/MBA '26, Founder</h2>
            <div className="flex flex-col md:flex-row items-start gap-12">
              {/* Image container with fixed, reasonable sizing */}
              <div className="flex-shrink-0 w-full md:w-auto">
                <div className="w-full md:w-80 h-96 overflow-hidden rounded-lg shadow-premium-lg relative border-2 border-border/50">
                  <Image
                    src={founderPhoto}
                    alt="Paul Clancy"
                    fill
                    className="object-cover"
                    style={{ objectPosition: 'center 0%' }}
                  />
                </div>
              </div>
              <div className="flex-1 text-left flex flex-col justify-center">
                <Card className="shadow-premium border-2 border-border/50 bg-gradient-to-br from-background to-muted/20">
                  <CardContent className="p-8">
                    <div className="text-lg text-muted-foreground leading-relaxed space-y-6 font-light">
                      <p>I'm a fifth-year MD/MBA student at the University of Virginia, pursuing a residency in anesthesiology. After watching my parents age and noticing barriers in our system to address prevention and root-cause disease, I started LifestyleAcademy to more easily share resources to help patients and friends have a more interactive role in their healthcare through evidence-based strategies focused on lifestyle medicine.</p>
                      
                      <p>I'm also the founder of <a href="https://www.admissionsacademy.org" target="_blank" rel="noopener noreferrer" className="text-primary font-medium underline hover:text-primary/80 transition-colors">AdmissionsAcademy.org</a>, a nonprofit organization committed to increasing equity in the medical school admissions process by expanding access to high-quality, free educational resources.</p>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default About;
