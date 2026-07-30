import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Terms of Use - LifestyleAcademy",
  description: "The terms and conditions that govern your use of LifestyleAcademy.",
}

const LAST_UPDATED = "July 30, 2026"

export default function TermsOfUsePage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="container px-4 sm:px-8 py-16 lg:py-24">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-4xl sm:text-5xl font-semibold mb-4 text-primary tracking-tight">
            Terms of Use
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
                These Terms of Use (&quot;Terms&quot;) govern your access to and use
                of the LifestyleAcademy website and services (the &quot;Service&quot;).
                By accessing or using the Service, you agree to be bound by these
                placeholder Terms. If you do not agree, please do not use the
                Service.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Not Medical Advice
              </h2>
              <p>
                The content on LifestyleAcademy is provided for general educational
                and informational purposes only and is not medical advice. It is not
                a substitute for professional diagnosis, treatment, or advice from a
                qualified healthcare provider. Always seek the advice of your
                physician or another qualified provider with any questions about your
                health, and never disregard professional medical advice because of
                something you read on the Service.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Use of the Service
              </h2>
              <p className="mb-4">
                You agree to use the Service only for lawful purposes and in
                accordance with these Terms. You agree not to:
              </p>
              <ul className="list-disc pl-6 space-y-2">
                <li>
                  Use the Service in any way that violates applicable laws or
                  regulations.
                </li>
                <li>
                  Attempt to gain unauthorized access to any part of the Service or
                  its related systems.
                </li>
                <li>
                  Interfere with or disrupt the integrity or performance of the
                  Service.
                </li>
                <li>
                  Copy, reproduce, or redistribute content except as expressly
                  permitted.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Intellectual Property
              </h2>
              <p>
                The Service and its original content, features, and functionality are
                owned by LifestyleAcademy and are protected by intellectual property
                laws. You may not use our trademarks, logos, or content without our
                prior written permission, except as allowed by these Terms.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Third-Party Links and Content
              </h2>
              <p>
                The Service may contain links to third-party websites or reference
                third-party content that we do not control. We are not responsible
                for the content, policies, or practices of any third parties, and
                links do not imply our endorsement.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Disclaimer of Warranties
              </h2>
              <p>
                The Service is provided on an &quot;as is&quot; and &quot;as
                available&quot; basis without warranties of any kind, whether express
                or implied. We do not warrant that the Service will be uninterrupted,
                error-free, or free of harmful components, or that the content is
                accurate, complete, or current.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Limitation of Liability
              </h2>
              <p>
                To the fullest extent permitted by law, LifestyleAcademy will not be
                liable for any indirect, incidental, special, consequential, or
                punitive damages arising out of or related to your use of the
                Service. The final scope of any limitation will be confirmed before
                launch.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Changes to These Terms
              </h2>
              <p>
                We may revise these Terms from time to time. When we do, we will
                update the &quot;Last updated&quot; date above. Your continued use of
                the Service after changes take effect constitutes your acceptance of
                the revised Terms.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4 text-primary">
                Contact Us
              </h2>
              <p>
                If you have questions about these Terms, please contact us at{" "}
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
