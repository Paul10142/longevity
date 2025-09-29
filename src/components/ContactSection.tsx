import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Mail, Phone, MapPin, Linkedin, Twitter, Globe, Calendar } from "lucide-react";

const ContactSection = () => {
  return (
    <section id="contact" className="py-8 lg:py-12 bg-primary/5">
      <div className="container">
        <h2 className="text-3xl font-bold tracking-tight mb-8">Connect & Collaborate</h2>
        <p className="text-xl text-muted-foreground mb-8">
          Ready to implement longevity strategies in your organization? 
          Let's discuss how lifestyle medicine can transform your executive team's health and performance.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Contact Information */}
          <div className="space-y-8">
            <div>
              <h3 className="text-2xl font-bold mb-6">Get In Touch</h3>
              <div className="space-y-6">
                <div className="flex items-center">
                  <Mail className="h-6 w-6 text-primary mr-4" />
                  <div>
                    <p className="font-semibold">Email</p>
                    <p className="text-muted-foreground">paul.clancy@longevityleadership.com</p>
                  </div>
                </div>
                
                <div className="flex items-center">
                  <Phone className="h-6 w-6 text-primary mr-4" />
                  <div>
                    <p className="font-semibold">Phone</p>
                    <p className="text-muted-foreground">+1 (555) 123-4567</p>
                  </div>
                </div>
                
                <div className="flex items-center">
                  <MapPin className="h-6 w-6 text-primary mr-4" />
                  <div>
                    <p className="font-semibold">Location</p>
                    <p className="text-muted-foreground">Charlottesville, VA</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Social Links */}
            <div>
              <h4 className="text-lg font-semibold mb-4">Follow & Connect</h4>
              <div className="flex space-x-4">
                <a href="#" className="bg-primary/10 text-primary p-3 rounded-lg hover:bg-primary/20 transition-colors">
                  <Linkedin className="h-5 w-5" />
                </a>
                <a href="#" className="bg-primary/10 text-primary p-3 rounded-lg hover:bg-primary/20 transition-colors">
                  <Twitter className="h-5 w-5" />
                </a>
                <a href="#" className="bg-primary/10 text-primary p-3 rounded-lg hover:bg-primary/20 transition-colors">
                  <Globe className="h-5 w-5" />
                </a>
              </div>
            </div>
          </div>

          {/* Contact Form */}
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Send a Message</CardTitle>
            </CardHeader>
            <CardContent className="text-base space-y-6">
              <form className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold mb-2">First Name</label>
                    <input
                      type="text"
                      className="w-full px-4 py-3 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                      placeholder="John"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-2">Last Name</label>
                    <input
                      type="text"
                      className="w-full px-4 py-3 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                      placeholder="Doe"
                    />
                  </div>
                </div>
                
                <div>
                  <label className="block text-sm font-semibold mb-2">Email</label>
                  <input
                    type="email"
                    className="w-full px-4 py-3 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="john@company.com"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-semibold mb-2">Company</label>
                  <input
                    type="text"
                    className="w-full px-4 py-3 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="Your Company"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-semibold mb-2">Message</label>
                  <textarea
                    rows={4}
                    className="w-full px-4 py-3 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="Tell me about your organization's health and wellness goals..."
                  ></textarea>
                </div>
                
                <button
                  type="submit"
                  className="w-full bg-[#60a5fa] text-white py-3 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors"
                >
                  Send Message
                </button>
              </form>
            </CardContent>
          </Card>
        </div>

        {/* Additional Resources */}
        <Card className="mt-16">
          <CardHeader>
            <CardTitle className="text-2xl">Schedule a Consultation</CardTitle>
          </CardHeader>
          <CardContent className="text-base space-y-4">
            <p className="text-muted-foreground">
              Book a personalized consultation to discuss how longevity strategies 
              can be implemented in your organization.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <button className="bg-[#60a5fa] text-white px-8 py-3 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors flex items-center justify-center">
                <Calendar className="h-5 w-5 mr-2" />
                Book 30-Min Consultation
              </button>
              <button className="border border-[#60a5fa] text-[#60a5fa] px-8 py-3 rounded-lg font-semibold hover:bg-[#60a5fa]/10 transition-colors">
                Download Executive Summary
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
};

export default ContactSection;
