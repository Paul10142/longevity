import { Card, CardContent } from "@/components/ui/card";
import { Calendar, ArrowRight } from "lucide-react";

const ContactSection = () => {

  return (
    <section id="contact" className="pt-[10px] pb-[40px] bg-gradient-to-b from-background to-muted/30">
      <div className="container">
        {/* Calendar Booking */}
        <div className="flex justify-center">
          <Card className="w-full max-w-5xl border-2 border-border/50 shadow-premium-lg overflow-hidden bg-gradient-to-br from-background via-accent/5 to-background">
            <CardContent className="flex flex-col lg:flex-row items-center justify-between p-8 sm:p-10 lg:p-12 gap-8">
              <div className="flex-1 text-center lg:text-left">
                <h3 className="text-2xl sm:text-3xl font-sans font-semibold mb-4 text-primary">I'd Love to Chat!</h3>
                <p className="text-lg sm:text-xl text-muted-foreground leading-relaxed font-light max-w-2xl">
                  This topic is something I'm really passionate about. If you feel the same way, I'd love to talk more!
                </p>
              </div>
              <a
                href="https://cal.com/admissionsacademy"
                target="_blank"
                rel="noopener noreferrer"
                className="group relative bg-accent text-accent-foreground px-8 py-4 rounded-md font-semibold hover:bg-accent/90 transition-all duration-300 flex items-center justify-center whitespace-nowrap shadow-premium hover:shadow-premium-lg transform hover:-translate-y-0.5"
              >
                <Calendar className="h-5 w-5 mr-3" />
                <span className="text-center">
                  <div>Book Time on</div>
                  <div>My Calendar</div>
                </span>
                <ArrowRight className="h-4 w-4 ml-3 group-hover:translate-x-1 transition-transform" />
              </a>
            </CardContent>
          </Card>
        </div>

      </div>
    </section>
  );
};

export default ContactSection;
