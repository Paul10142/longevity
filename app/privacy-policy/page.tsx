import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Privacy Policy - LifestyleAcademy",
  description: "How LifestyleAcademy collects, uses, and protects your information.",
}

const LAST_UPDATED = "July 30, 2026"

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="container px-4 sm:px-8 py-16 lg:py-24">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-4xl sm:text-5xl font-semibold mb-4 text-primary tracking-tight">
            Privacy Policy
          </h1>
          <p className="text-sm text-muted-foreground mb-8">
            Last updated: {LAST_UPDATED}
          </p>

          <div className="mb-10 rounded-md border border-primary/20 bg-muted/40 px-4 py-3">
            <p className="text-sm text-foreground font-medium">
              Draft / placeholder — to be reviewed by counsel before launch. This
              text is generic boilerplate and is not a finalized or binding legal
              document.
            </p>
          </div>

          <div className="space-y-10 text-muted-foreground leading-relaxed">
            <section>
              <p>
                LifestyleAcademy (&quot;we,&quot; &quot;us,&quot; or &quot;our&quot;)
                respects your privacy. This Privacy Policy explains, in general
                terms, how we may collect, use, and share information when you
                visit our website and use our services. By using the site, you
                agree to the practices described in this placeholder policy.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Information We Collect
              </h2>
              <p className="mb-4">
                We may collect information you provide directly, information
                collected automatically as you use the site, and information from
                third-party services, including:
              </p>
              <ul className="list-disc pl-6 space-y-2">
                <li>
                  Information you provide, such as your name and email address when
                  you contact us or sign up for updates.
                </li>
                <li>
                  Usage and device information, such as pages viewed, browser type,
                  and general location, collected through cookies and similar
                  technologies.
                </li>
                <li>
                  Information from third parties, such as analytics providers, that
                  help us understand how the site is used.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                How We Use Your Information
              </h2>
              <p className="mb-4">We may use the information we collect to:</p>
              <ul className="list-disc pl-6 space-y-2">
                <li>Provide, operate, and improve the site and our services.</li>
                <li>Respond to your questions, comments, and requests.</li>
                <li>
                  Send you updates and communications that you have requested.
                </li>
                <li>
                  Analyze usage trends and maintain the security of the site.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                How We Share Information
              </h2>
              <p>
                We do not sell your personal information. We may share information
                with service providers who perform functions on our behalf, when
                required by law, or in connection with a business transfer. Any such
                sharing will be subject to the finalized version of this policy.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Cookies and Tracking
              </h2>
              <p>
                We may use cookies and similar technologies to operate the site,
                remember your preferences, and understand usage. You can usually
                control cookies through your browser settings, though some features
                of the site may not function properly without them.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Data Retention and Security
              </h2>
              <p>
                We retain personal information only for as long as reasonably
                necessary for the purposes described in this policy, and we use
                reasonable administrative and technical measures to protect it. No
                method of transmission or storage is completely secure, however, and
                we cannot guarantee absolute security.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Your Choices and Rights
              </h2>
              <p>
                Depending on where you live, you may have rights to access, correct,
                or delete your personal information, or to object to certain
                processing. To make a request, please contact us using the details
                below. Final details of these rights will be confirmed before
                launch.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Children&apos;s Privacy
              </h2>
              <p>
                The site is not directed to children, and we do not knowingly
                collect personal information from children. If you believe a child
                has provided us with personal information, please contact us so we
                can address it.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Changes to This Policy
              </h2>
              <p>
                We may update this Privacy Policy from time to time. When we do, we
                will revise the &quot;Last updated&quot; date above. Your continued
                use of the site after changes take effect indicates your acceptance
                of the updated policy.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Contact Us
              </h2>
              <p>
                If you have questions about this Privacy Policy, please contact us at{" "}
                <a
                  href="mailto:paul@admissionsacademy.org"
                  className="text-primary hover:text-primary/80 transition-colors font-medium"
                >
                  paul@admissionsacademy.org
                </a>
                .
              </p>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
