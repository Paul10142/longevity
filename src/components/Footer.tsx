import { Mail, Linkedin } from "lucide-react";

const Footer = () => {
  return (
    <footer className="bg-muted/50 border-t">
      <div className="container py-12">
        <div className="flex flex-col md:flex-row justify-between items-center space-y-4 md:space-y-0">
            <div className="text-center md:text-left">
              <p className="text-muted-foreground mb-2">
                &copy; 2024 Lifestyle Academy | Brought to you by <a href="https://www.admissionsacademy.org" target="_blank" rel="noopener noreferrer" className="text-primary underline hover:text-primary/80 transition-colors">AdmissionsAcademy</a>
              </p>
              <div className="flex items-center space-x-4 mt-4 justify-center md:justify-start">
                <a href="mailto:paul@admissionsacademy.org" className="text-muted-foreground hover:text-primary transition-colors">
                  <Mail className="h-5 w-5" />
                </a>
                <a href="https://www.linkedin.com/in/paulclancy3/" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors">
                  <Linkedin className="h-5 w-5" />
                </a>
                <p className="text-sm text-muted-foreground">
                  Created by <a href="https://www.linkedin.com/in/paulclancy3/" target="_blank" rel="noopener noreferrer" className="text-primary underline hover:text-primary/80 transition-colors">Paul Clancy</a>
                </p>
              </div>
          </div>
          <div className="flex flex-wrap justify-center md:justify-end space-x-6 text-sm">
            <a href="#privacy-policy" className="text-muted-foreground hover:text-primary transition-colors">Privacy Policy</a>
            <a href="#terms-of-use" className="text-muted-foreground hover:text-primary transition-colors">Terms of Use</a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
