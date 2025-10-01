import { useState, useRef } from 'react';
import Header from './components/Header';
import HeroSection from './components/HeroSection';
import ExecutiveTips from './components/ExecutiveTips';
import ResourcesSection from './components/ResourcesSection';
import About from './components/About';
import ContactSection from './components/ContactSection';
import Footer from './components/Footer';

function App() {
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const mainRef = useRef<HTMLDivElement>(null);

  const nextMatch = () => {
    if (currentIndex < matchCount - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  };

  const prevMatch = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header 
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        matchCount={matchCount}
        currentIndex={currentIndex}
        nextMatch={nextMatch}
        prevMatch={prevMatch}
      />
      <div ref={mainRef}>
        <HeroSection />
        <ExecutiveTips />
        <ResourcesSection />
        <About />
        <ContactSection />
      </div>
      <Footer />
    </div>
  );
}

export default App;
