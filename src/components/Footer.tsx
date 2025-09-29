import { Mail, Phone, MapPin } from "lucide-react";

const Footer = () => {
  return (
    <footer className="bg-muted/50 border-t">
      <div className="container py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Logo and Description */}
          <div className="col-span-1 md:col-span-2">
            <div className="flex items-center space-x-2 mb-4">
              <div className="h-8 w-8 bg-[#60a5fa] rounded-full flex items-center justify-center">
                <span className="text-white font-bold text-sm">L</span>
              </div>
              <span className="text-xl font-bold text-[#60a5fa]">Longevity Leadership</span>
            </div>
            <p className="text-muted-foreground mb-6 max-w-md">
              Empowering executives with evidence-based lifestyle medicine strategies 
              to optimize health, performance, and longevity.
            </p>
            <div className="flex space-x-4">
              <a href="#" className="text-muted-foreground hover:text-primary transition-colors">
                <Mail className="h-5 w-5" />
              </a>
              <a href="#" className="text-muted-foreground hover:text-primary transition-colors">
                <Phone className="h-5 w-5" />
              </a>
              <a href="#" className="text-muted-foreground hover:text-primary transition-colors">
                <MapPin className="h-5 w-5" />
              </a>
            </div>
          </div>

          {/* Quick Links */}
          <div>
            <h3 className="text-lg font-semibold mb-4">Quick Links</h3>
            <ul className="space-y-2">
              <li><a href="#presentation" className="text-muted-foreground hover:text-primary transition-colors">Presentation</a></li>
              <li><a href="#resources" className="text-muted-foreground hover:text-primary transition-colors">Resources</a></li>
              <li><a href="#tips" className="text-muted-foreground hover:text-primary transition-colors">Executive Tips</a></li>
              <li><a href="#contact" className="text-muted-foreground hover:text-primary transition-colors">Contact</a></li>
            </ul>
          </div>

          {/* Contact Info */}
          <div>
            <h3 className="text-lg font-semibold mb-4">Contact</h3>
            <div className="space-y-2 text-muted-foreground">
              <p>paul.clancy@longevityleadership.com</p>
              <p>+1 (555) 123-4567</p>
              <p>Charlottesville, VA</p>
            </div>
          </div>
        </div>

        <div className="border-t border-border mt-8 pt-8 text-center text-muted-foreground">
          <p>&copy; 2024 Longevity Leadership. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
