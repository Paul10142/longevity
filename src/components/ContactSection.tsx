import { Card, CardContent } from "@/components/ui/card";
import { Calendar } from "lucide-react";

const ContactSection = () => {
  return (
    <section id="contact" className="py-2 lg:py-3 bg-white mb-4">
      <div className="container">
        {/* Calendar Booking */}
        <div className="mt-4 flex justify-center">
          <Card className="w-1/2 bg-blue-50 border-blue-200">
            <CardContent className="flex items-center justify-between p-6">
              <div className="flex-1 mr-6">
                <h3 className="text-2xl font-bold mb-2">Let's Chat</h3>
                <p className="text-muted-foreground">
                  This topic is something I'm really passionate about. If you feel the same way, I'd love to talk more!
                </p>
              </div>
              <a
                href="https://cal.com/admissionsacademy"
                target="_blank"
                rel="noopener noreferrer"
                className="bg-[#60a5fa] text-white px-6 py-3 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors flex items-center justify-center whitespace-nowrap"
              >
                <Calendar className="h-5 w-5 mr-2" />
                <span className="text-center">
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
