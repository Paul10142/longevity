import { useState, useRef, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Header from './components/Header';
import HeroSection from './components/HeroSection';
import ExecutiveTips from './components/ExecutiveTips';
import ResourcesSection from './components/ResourcesSection';
import About from './components/About';
import ContactSection from './components/ContactSection';
import Footer from './components/Footer';
import Transcript from './pages/Transcript';

function HomePage() {
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

  // Handle hash navigation when page loads
  useEffect(() => {
    const handleHashNavigation = () => {
      const hash = window.location.hash;
      if (hash) {
        setTimeout(() => {
          const element = document.querySelector(hash);
          if (element) {
            const y = element.getBoundingClientRect().top + window.pageYOffset - 64; // 64px header height
            window.scrollTo({ top: y, behavior: "smooth" });
          }
        }, 100); // Small delay to ensure page is loaded
      }
    };

    handleHashNavigation();
  }, []);

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

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/transcript" element={<Transcript />} />
      </Routes>
    </Router>
  );
}

export default App;
