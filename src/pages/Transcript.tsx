import Header from '../components/Header';
import Footer from '../components/Footer';
import TranscriptContent from '../components/TranscriptContent';
import { useState, useRef } from 'react';

const Transcript = () => {
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
      <div ref={mainRef} className="container mx-auto px-4 py-12">
        <div className="max-w-[850px] mx-auto">
          <h1 className="text-4xl font-bold mb-8">Cleaned Up Transcript - Blue Ridge Mountain Rotary Club Presentation, 10/1/25</h1>
          <div className="prose prose-lg max-w-none">
            <TranscriptContent />
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
};

export default Transcript;
