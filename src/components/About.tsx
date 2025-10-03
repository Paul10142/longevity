import { Card, CardContent } from "@/components/ui/card";
import founderPhoto from "@/assets/founder-photo.jpg";

const About = () => {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-8 sm:py-12">
        {/* About Lifestyle Academy Section */}
        <section className="mb-6 sm:mb-8">
          <h2 className="text-2xl sm:text-3xl font-bold text-center text-foreground mb-8 sm:mb-12">About LifestyleAcademy</h2>
          
          <div className="max-w-4xl mx-auto">
            <Card className="mb-6 sm:mb-8">
              <CardContent className="p-4 sm:p-6 lg:p-8">
                <div className="text-base sm:text-lg text-muted-foreground leading-relaxed space-y-4">
                  <p>
                    LifestyleAcademy was founded by Paul Clancy and brought to you by <a href="https://www.admissionsacademy.org" target="_blank" rel="noopener noreferrer" className="text-primary underline hover:text-primary/80 transition-colors">AdmissionsAcademy.org</a>, 
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
        <section id="about" className="mb-4 pt-8">
          <h2 className="text-3xl font-bold text-center text-foreground mb-12">Paul Clancy MD/MBA '26, Founder</h2>
          <div className="flex flex-col md:flex-row items-center gap-8 max-w-4xl mx-auto">
            {/* Image container with fixed, reasonable sizing */}
            <div className="flex-shrink-0">
              <div className="w-64 h-80 md:w-80 md:h-96 overflow-hidden rounded-lg shadow-lg">
                <img
                  src={founderPhoto}
                  alt="Paul Clancy"
                  className="w-full h-full object-cover"
                  style={{ objectPosition: 'center 0%' }}
                />
              </div>
            </div>
            <div className="flex-1 text-left flex flex-col justify-center">
              <div className="text-lg text-muted-foreground leading-relaxed space-y-4">
                <p>I'm a fifth-year MD/MBA student at the University of Virginia, pursuing a residency in anesthesiology. After watching my parents age and noticing barriers in our system to address prevention and root-cause disease, I started LifestyleAcademy to more easily share resources to help patients and friends have a more interactive role in their healthcare through evidence-based strategies focused on lifestyle medicine.</p>
                
                <p>I'm also the founder of <a href="https://www.admissionsacademy.org" target="_blank" rel="noopener noreferrer" className="text-primary underline hover:text-primary/80 transition-colors">AdmissionsAcademy.org</a>, a nonprofit organization committed to increasing equity in the medical school admissions process by expanding access to high-quality, free educational resources.</p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default About;
