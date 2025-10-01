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
            <strong>Last updated:</strong> January 1, 2025
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">Acceptance of Terms</h2>
          <p className="mb-4">
            By accessing and using this website, you accept and agree to be bound by the terms 
            and provision of this agreement.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">Use License</h2>
          <p className="mb-4">
            Permission is granted to temporarily download one copy of the materials on this website 
            for personal, non-commercial transitory viewing only. This is the grant of a license, 
            not a transfer of title.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">Disclaimer</h2>
          <p className="mb-4">
            The materials on this website are provided on an 'as is' basis. We make no warranties, 
            expressed or implied, and hereby disclaim and negate all other warranties including 
            without limitation, implied warranties or conditions of merchantability, fitness for 
            a particular purpose, or non-infringement of intellectual property or other violation of rights.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">Medical Disclaimer</h2>
          <p className="mb-4">
            The information provided on this website is for educational purposes only and is not 
            intended as a substitute for professional medical advice, diagnosis, or treatment. 
            Always seek the advice of your physician or other qualified health provider.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">Limitations</h2>
          <p className="mb-4">
            In no event shall LifestyleAcademy or its suppliers be liable for any damages 
            (including, without limitation, damages for loss of data or profit, or due to business 
            interruption) arising out of the use or inability to use the materials on this website.
          </p>
          
          <h2 className="text-2xl font-semibold mb-4">Governing Law</h2>
          <p className="mb-4">
            These terms and conditions are governed by and construed in accordance with the laws 
            and you irrevocably submit to the exclusive jurisdiction of the courts in that state or location.
          </p>
        </div>
      </div>
      <Footer />
    </div>
  );
};

export default TermsOfUse;
