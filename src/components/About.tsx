import { Card, CardContent } from "@/components/ui/card";
import founderPhoto from "@/assets/founder-photo.jpg";

const About = () => {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-12">
        {/* About Lifestyle Academy Section */}
        <section className="mb-8">
          <h2 className="text-3xl font-bold text-center text-foreground mb-12">About Lifestyle Academy</h2>
          
          <div className="max-w-4xl mx-auto">
            <Card className="mb-8">
              <CardContent className="p-8">
                <div className="text-lg text-muted-foreground leading-relaxed space-y-4">
                  <p>
                    Lifestyle Academy is brought to you by <a href="https://www.admissionsacademy.org" target="_blank" rel="noopener noreferrer" className="text-primary underline hover:text-primary/80 transition-colors">AdmissionsAcademy.org</a>, 
                    an organization committed to expanding access to educational resources for pre-medical and pre-health students nationwide.
                  </p>
                  
                  <p>
                    Our mission is to empower patients with evidence-based strategies for optimizing their health, wellness, performance, and longevity 
                    to help them lead healthier, happier lives. Drawing from the latest research in lifestyle medicine and insights from longevity leaders 
                    such as Peter Attia and Dr. John DePadrick, we provide tools and frameworks tailored for patients who want to learn more and are hoping to lead better lives.
                  </p>
                  
                  <p>
                    Whether you're looking to optimize your cognitive performance, manage stress more effectively, or implement 
                    sustainable health habits, Lifestyle Academy provides the evidence-based guidance you need to thrive both 
                    personally and professionally while building a foundation for long-term happiness and health.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Founder Section */}
        <section id="about" className="mb-4">
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
                <p>I'm a fifth-year MD/MBA student at the University of Virginia. I founded Lifestyle Academy to help individuals take control of their health and optimize health through evidence-based lifestyle medicine strategies.</p>
                
                <p>I'm also the founder of <a href="https://www.admissionsacademy.org" target="_blank" rel="noopener noreferrer" className="text-primary underline hover:text-primary/80 transition-colors">AdmissionsAcademy.org</a>, a nonprofit organization committed to increasing equity in the medical school admissions process by expanding access to high-quality, free educational resources.</p>
                
                <p>Outside of my work in medical education, I'm active in disability advocacy and mentorship. In my free time I enjoy reading, playing piano, and working out.</p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default About;
