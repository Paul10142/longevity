import { Card, CardContent } from "@/components/ui/card";
import { Calendar } from "lucide-react";

const ContactSection = () => {

  return (
    <section id="contact" className="py-6 sm:py-8 lg:py-12 bg-white mb-4">
      <div className="container">
        {/* Calendar Booking */}
        <div className="flex justify-center mb-8">
          <Card className="w-full max-w-4xl bg-blue-50 border-blue-200">
            <CardContent className="flex flex-col sm:flex-row items-center justify-between p-4 sm:p-6">
              <div className="flex-1 sm:mr-6 mb-4 sm:mb-0">
                <h3 className="text-xl sm:text-2xl font-bold mb-2">I'd Love to Chat!</h3>
                <p className="text-sm sm:text-base text-muted-foreground">
                  This topic is something I'm really passionate about. If you feel the same way, I'd love to talk more!
                </p>
              </div>
              <a
                href="https://cal.com/admissionsacademy"
                target="_blank"
                rel="noopener noreferrer"
                className="bg-[#60a5fa] text-white px-4 sm:px-6 py-2 sm:py-3 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors flex items-center justify-center whitespace-nowrap w-full sm:w-auto min-w-fit"
              >
                <Calendar className="h-4 w-4 sm:h-5 sm:w-5 mr-2" />
                <span className="text-center text-sm sm:text-base">
                  <div>Book Time on</div>
                  <div>My Calendar</div>
                </span>
              </a>
            </CardContent>
          </Card>
        </div>

      </div>
    </section>
  );
};

export default ContactSection;
