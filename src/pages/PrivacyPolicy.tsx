import Header from "@/components/Header";
import Footer from "@/components/Footer";

const PrivacyPolicy = () => {
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
        <h1 className="text-4xl font-bold mb-8 text-foreground">Privacy Policy</h1>
        
        <div className="prose prose-lg max-w-none text-foreground">
          <p className="text-lg mb-6">
            <strong>Effective Date:</strong> October 1, 2025
          </p>
          
          <p className="mb-6">
            LifestyleAcademy ("we," "us," or "our") is committed to protecting your privacy. This Privacy Policy 
            explains how we collect, use, disclose, and safeguard your information when you use our Services.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">1. Information We Collect</h2>
          <p className="mb-4"><strong>Personal Data:</strong> Information you provide when creating an account, such as your name and email address.</p>
          <p className="mb-4"><strong>Health Information:</strong> Any health-related information you voluntarily share with us, such as wellness goals, lifestyle preferences, or health interests. This information is used solely to personalize your experience and provide relevant resources.</p>
          <p className="mb-4"><strong>Usage Data:</strong> Information about your interactions with our Services, such as resources viewed, articles read, and educational content accessed.</p>
          <p className="mb-4"><strong>Technical Data:</strong> Information automatically collected when you access the Services, such as your IP address, browser type, and operating system. We collect this data using cookies and similar technologies, including Google Analytics.</p>
          
          <h2 className="text-2xl font-semibold mb-4">2. How We Use Your Information</h2>
          <ul className="list-disc pl-6 mb-4 space-y-2">
            <li>Provide, operate, and maintain our Services</li>
            <li>Process your transactions and manage your account</li>
            <li>Improve our platform and develop new health-focused features</li>
            <li>Communicate with you, including sending service-related emails and educational content (you may opt-out of marketing communications)</li>
            <li>Monitor and analyze usage and trends to enhance user experience and provide better health resources</li>
            <li>Personalize your experience with relevant lifestyle medicine content and recommendations</li>
          </ul>
          
          <h2 className="text-2xl font-semibold mb-4">3. How We Share Your Information</h2>
          <p className="mb-4"><strong>Service Providers:</strong> We share information with vendors who perform services on our behalf, such as Google Analytics for website analytics and email service providers for communications.</p>
          <p className="mb-4"><strong>Legal Obligations:</strong> We may disclose your information if required by law or in response to a valid legal request.</p>
          <p className="mb-4"><strong>Health Information Protection:</strong> Any health-related information you share with us is treated with the highest level of confidentiality and is never shared with third parties without your explicit consent, except as required by law.</p>
          
          <h2 className="text-2xl font-semibold mb-4">4. Cookies and Tracking Technologies</h2>
          <p className="mb-4">
            We use cookies to help operate and analyze our Services. Google Analytics is used to understand how our Services are being used. 
            You can control the use of cookies at the individual browser level.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">5. Data Security</h2>
          <p className="mb-4">
            We implement reasonable administrative, technical, and physical security measures to protect your information from unauthorized access, 
            use, or disclosure. This includes encryption of sensitive data and secure data storage practices.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">6. Your Legal Rights</h2>
          <p className="mb-4">Depending on your location, you may have certain rights regarding your personal data.</p>
          <p className="mb-4"><strong>For Users in the European Economic Area (GDPR):</strong> You have the right to access, rectify, erase, restrict processing of, and request portability of your personal data. You also have the right to object to processing and to withdraw consent.</p>
          <p className="mb-4"><strong>For Residents of California (CCPA/CPRA):</strong> You have the right to know what personal information we collect, use, and disclose. You have the right to request deletion of your personal information and to correct inaccurate information. You also have the right to opt-out of the "sale" or "sharing" of your personal information. To exercise these rights, please contact us. We will not discriminate against you for exercising your CCPA rights.</p>
          <p className="mb-4">To make a request regarding your data, please contact us at the email below.</p>
          
          <h2 className="text-2xl font-semibold mb-4">7. Children's Privacy</h2>
          <p className="mb-4">Our Services are not intended for or directed at children under the age of 16. We do not knowingly collect personal information from children.</p>
          
          <h2 className="text-2xl font-semibold mb-4">8. Changes to This Privacy Policy</h2>
          <p className="mb-4">
            We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new policy on this page 
            and updating the "Effective Date."
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">9. Contact Us</h2>
          <p className="mb-4">
            If you have any questions or concerns about this Privacy Policy, please contact us at: paul@lifestyleacademy.org
          </p>
        </div>
      </div>
      <Footer />
    </div>
  );
};

export default PrivacyPolicy;
