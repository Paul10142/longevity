import Header from "@/components/Header";
import Footer from "@/components/Footer";

const TermsOfUse = () => {
  return (
    <div className="min-h-screen bg-background">
      <Header 
        searchQuery=""
        setSearchQuery={() => {}}
        matchCount={0}
        currentIndex={0}
        nextMatch={() => {}}
        prevMatch={() => {}}
      />
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <h1 className="text-4xl font-bold mb-8 text-foreground">Terms of Use</h1>
        
        <div className="prose prose-lg max-w-none text-foreground">
          <p className="text-lg mb-6">
            <strong>Effective Date:</strong> October 1, 2025
          </p>
          
          <p className="mb-6">
            Welcome to LifestyleAcademy. These Terms of Service ("Terms") govern your use of the website, 
            resources, and services (collectively, the "Services") provided by LifestyleAcademy ("we," "us," or "our"). 
            By accessing or using our Services, you agree to be bound by these Terms.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">1. Agreement to Terms</h2>
          <p className="mb-4">
            By accessing or using our Services, you acknowledge that you have read, understood, and agree to be bound by these Terms. 
            If you do not agree, you may not use the Services.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">2. User Accounts</h2>
          <p className="mb-4">If you create an account with us, you agree to:</p>
          <ul className="list-disc pl-6 mb-4 space-y-2">
            <li>Provide accurate, current, and complete information during registration</li>
            <li>Maintain the security of your password and accept all risks of unauthorized access to your account</li>
            <li>Promptly notify us if you discover or suspect any security breaches</li>
          </ul>
          
          <h2 className="text-2xl font-semibold mb-4">3. Intellectual Property Rights</h2>
          <p className="mb-4">
            All content provided through the Services, including but not limited to educational materials, articles, 
            resources, text, graphics, logos, and software (the "Content"), is the exclusive property of LifestyleAcademy 
            and its licensors. We grant you a limited, non-exclusive, non-transferable, and revocable license to access 
            and use the Content for your personal, non-commercial educational purposes only. You are expressly prohibited 
            from reproducing, distributing, modifying, creating derivative works of, publicly displaying, or reselling any 
            Content without our prior written consent.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">4. User Conduct</h2>
          <p className="mb-4">You agree not to:</p>
          <ul className="list-disc pl-6 mb-4 space-y-2">
            <li>Share account access with others or distribute our educational content without permission</li>
            <li>Harass, threaten, or defame any other user or instructor</li>
            <li>Post or transmit any content that is unlawful, obscene, defamatory, or otherwise objectionable</li>
            <li>Violate any applicable local, state, national, or international law</li>
          </ul>
          
          <h2 className="text-2xl font-semibold mb-4">5. Medical and Health Disclaimers</h2>
          <p className="mb-4">
            <strong>No Medical Advice:</strong> The Services are provided for educational and informational purposes only. 
            LifestyleAcademy makes no representation, warranty, or guarantee of any kind that use of our Services will 
            improve your health, prevent disease, or provide any specific health outcomes.
          </p>
          <p className="mb-4">
            <strong>Not a Substitute for Medical Care:</strong> The information provided through our Services is not 
            intended as a substitute for professional medical advice, diagnosis, or treatment. Always seek the advice 
            of your physician or other qualified health provider with any questions you may have regarding a medical condition.
          </p>
          <p className="mb-4">
            <strong>Individual Results May Vary:</strong> Health and wellness outcomes depend on individual factors including 
            genetics, lifestyle, and adherence to recommendations. We make no guarantees about specific health results.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">6. Disclaimers</h2>
          <p className="mb-4">
            <strong>Service Provided "As-Is":</strong> The Services are provided on an "as is" and "as available" basis 
            without warranties of any kind, either express or implied.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">7. Limitation of Liability</h2>
          <p className="mb-4">
            To the fullest extent permitted by law, LifestyleAcademy shall not be liable for any indirect, incidental, 
            special, consequential, or punitive damages, or any loss of profits or revenues, whether incurred directly 
            or indirectly, arising from your use of the Services. In no event shall our aggregate liability exceed 
            the total amount you paid to us in the six (6) months preceding the event giving rise to the claim.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">8. Termination</h2>
          <p className="mb-4">
            We reserve the right to suspend or terminate your account and access to the Services, at our sole discretion, 
            without notice or liability, for any reason, including if you breach these Terms. You may cancel your account 
            at any time by contacting us.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">9. Governing Law and Dispute Resolution</h2>
          <p className="mb-4">
            These Terms shall be governed by the laws of the State of Virginia, without regard to its conflict of law principles. 
            Any dispute arising from these Terms shall be resolved through final and binding arbitration in Charlottesville, Virginia, 
            rather than in court.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">10. Contact Information</h2>
          <p className="mb-4">
            For any questions about these Terms, please contact us at: paul@lifestyleacademy.org
          </p>
        </div>
      </div>
      <Footer />
    </div>
  );
};

export default TermsOfUse;
