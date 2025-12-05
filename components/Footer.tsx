import Link from "next/link"
import { Mail, Linkedin } from "lucide-react"

const Footer = () => {
  return (
    <footer className="bg-background border-t border-border/50">
      <div className="container py-12 sm:py-16">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row justify-between items-start gap-8 lg:gap-12">
            {/* Brand Section */}
            <div className="flex-1">
              <div className="flex items-center space-x-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center">
                  <span className="text-white text-lg font-sans font-bold">L</span>
                </div>
                <div>
                  <span className="text-xl font-sans font-semibold text-primary tracking-tight">LifestyleAcademy</span>
                </div>
              </div>
              <p className="text-muted-foreground mb-6 leading-relaxed max-w-md">
                Evidence-based strategies for optimizing your health and wellness through lifestyle medicine.
              </p>
              <div className="flex items-center space-x-4">
                <a
                  href="mailto:paul@admissionsacademy.org"
                  className="text-muted-foreground hover:text-primary transition-colors p-2 hover:bg-muted rounded-md"
                  aria-label="Email"
                >
                  <Mail className="h-5 w-5" />
                </a>
                <a
                  href="https://www.linkedin.com/in/paulclancy3/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-primary transition-colors p-2 hover:bg-muted rounded-md"
                  aria-label="LinkedIn"
                >
                  <Linkedin className="h-5 w-5" />
                </a>
              </div>
            </div>

            {/* Links Section */}
            <div className="flex flex-col sm:flex-row gap-8 lg:gap-12">
              <div>
                <h4 className="font-semibold text-foreground mb-4 text-sm uppercase tracking-wider">Organization</h4>
                <ul className="space-y-3">
                  <li>
                    <a
                      href="https://www.admissionsacademy.org"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-primary transition-colors text-sm"
                    >
                      AdmissionsAcademy
                    </a>
                  </li>
                  <li>
                    <Link
                      href="/privacy-policy"
                      className="text-muted-foreground hover:text-primary transition-colors text-sm"
                    >
                      Privacy Policy
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/terms-of-use"
                      className="text-muted-foreground hover:text-primary transition-colors text-sm"
                    >
                      Terms of Use
                    </Link>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          {/* Bottom Bar */}
          <div className="mt-12 pt-8 border-t border-border/50 flex flex-col sm:flex-row justify-between items-center gap-4">
            <p className="text-sm text-muted-foreground text-center sm:text-left">
              &copy; 2024 LifestyleAcademy. All rights reserved.
            </p>
            <p className="text-sm text-muted-foreground text-center sm:text-right">
              Created by{" "}
              <a
                href="https://www.linkedin.com/in/paulclancy3/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:text-primary/80 transition-colors font-medium"
              >
                Paul Clancy
              </a>
            </p>
          </div>
        </div>
      </div>
    </footer>
  )
}

export default Footer
