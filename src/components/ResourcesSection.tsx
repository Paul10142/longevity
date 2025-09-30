import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BookOpen, ExternalLink, Star, Headphones, Play } from "lucide-react";

const ResourcesSection = () => {
  const resources = [
    {
      category: "Essential Books",
      items: [
        {
          title: "Outlive: The Science and Art of Longevity",
          author: "Dr. Peter Attia",
          description: "This book started it all for me and really opened my eyes to the structure of our healthcare system and how unequipped we are to treat chronic disease. It provides a great foundational overview of various health metrics and the current body of research on lifestyle medicine as a whole.",
          type: "Book",
          rating: 5,
          link: "https://www.amazon.com/Outlive-Longevity-Peter-Attia-MD/dp/0593236599",
          image: "https://images-na.ssl-images-amazon.com/images/I/71Q4+4K2YJL._AC_UL600_SR600,400_.jpg"
        },
        {
          title: "Atomic Habits: An Easy & Proven Way to Build Good Habits & Break Bad Ones",
          author: "James Clear",
          description: "A comprehensive guide to building better habits and breaking bad ones. This book provides practical strategies for creating lasting behavior change through small, incremental improvements.",
          type: "Book",
          rating: 5,
          link: "https://www.amazon.com/Atomic-Habits-Proven-Build-Break/dp/0735211299",
          image: "https://images-na.ssl-images-amazon.com/images/I/51Tlm0L0-EL._AC_UL600_SR600,400_.jpg"
        },
        {
          title: "Good Energy: The Surprising Connection Between Metabolism and Limitless Health",
          author: "Dr. Casey Means and Calley Means",
          description: "Focuses specifically on the global impact of metabolic health on all of the body systems, as well as the role of environmental factors on lifestyle and overall health.",
          type: "Book",
          rating: 5,
          link: "https://www.amazon.com/Good-Energy-Surprising-Connection-Metabolism/dp/0593712641",
          image: "https://images-na.ssl-images-amazon.com/images/I/71Q4+4K2YJL._AC_UL600_SR600,400_.jpg"
        }
      ]
    },
    {
      category: "Top Podcasts",
      items: [
        {
          title: "The Drive – Peter Attia MD",
          author: "Peter Attia, MD",
          description: "My favorite podcast. Dr. Attia meets with a variety of experts across various disciplines, not only focusing on biochemistry and medical science, but also mental health and happiness. Almost every episode has me stop what I'm doing multiple times and think, 'Holy crap, I never knew this.'",
          type: "Podcast",
          rating: 5,
          link: "https://peterattiamd.com/podcast/",
          image: null
        },
        {
          title: "FoundMyFitness – Rhonda Patrick PhD",
          author: "Rhonda Patrick, PhD",
          description: "Similar to The Drive in that it goes deep on the clinical side and has a variety of expert guests. Often leans slightly towards physical activity and exercise protocols, which is nice.",
          type: "Podcast",
          rating: 5,
          link: "https://www.foundmyfitness.com/",
          image: null
        },
        {
          title: "Huberman Lab Podcast – Andrew Huberman PhD",
          author: "Andrew Huberman, PhD",
          description: "Engaging and geared more toward a mass audience (vs. clinician focus) and doesn't always go as deep into the science. Each episode offers protocols you can implement in your life.",
          type: "Podcast",
          rating: 5,
          link: "https://www.hubermanlab.com/",
          image: null
        },
        {
          title: "Perform with Dr. Andy Galpin, PhD",
          author: "Dr. Andy Galpin, PhD",
          description: "A newer podcast by an exercise scientist and performance coach who works with top athletes nationwide. More focused on exercise and athletics but also covers nutrition and supplements.",
          type: "Podcast",
          rating: 5,
          link: "https://performpodcast.com/",
          image: null
        }
      ]
    },
    {
      category: "Featured Podcast Episodes",
      items: [
        {
          title: "Dr. Ben Bikman: How To Reverse Insulin Resistance Through Diet, Exercise, & Sleep",
          author: "FoundMyFitness – Episode #104",
          description: "Deep dive into insulin resistance and practical strategies for reversal through lifestyle interventions.",
          type: "Episode",
          rating: 5,
          link: "https://www.foundmyfitness.com/episodes/ben-bikman"
        },
        {
          title: "Dr. Keith Baar: Simple Exercises That Can Repair Tendons, Collagen Fact vs. Fiction",
          author: "The Tim Ferriss Show – Episode #797",
          description: "Comprehensive look at tendon repair, collagen science, and the anti-RICE protocol for injury recovery.",
          type: "Episode",
          rating: 5,
          link: "https://tim.blog/2025/02/26/dr-keith-baar/"
        },
        {
          title: "Dr. Andy Galpin: The Optimal Diet, Supplement, & Recovery Protocol for Peak Performance",
          author: "FoundMyFitness – Episode #101",
          description: "Evidence-based protocols for nutrition, supplementation, and recovery strategies for optimal performance.",
          type: "Episode",
          rating: 5,
          link: "https://www.foundmyfitness.com/episodes/andy-galpin"
        },
        {
          title: "Max Lugavere – The Terrifying Link Between Diet & Mental Health",
          author: "Modern Wisdom – Episode #709",
          description: "Explores the critical connection between nutrition and mental health, with actionable insights for cognitive optimization.",
          type: "Episode",
          rating: 5,
          link: "https://podcasts.apple.com/za/podcast/709-max-lugavere-the-terrifying-link-between-diet/id1347973549?i=1000635388383"
        }
      ]
    }
  ];

  const renderStars = (rating: number) => {
    return Array.from({ length: 5 }, (_, i) => (
      <Star
        key={i}
        className={`h-4 w-4 ${i < rating ? 'text-yellow-400 fill-current' : 'text-gray-300'}`}
      />
    ));
  };

  return (
    <section id="resources" className="py-8 lg:py-12">
      <div className="container">
        <h2 className="text-3xl font-bold tracking-tight mb-8">Next Steps for Learning</h2>
        <p className="text-xl text-muted-foreground mb-8">
          Curated books, podcasts, and episodes to deepen your understanding 
          of longevity and lifestyle medicine. These are the resources that have 
          shaped my own journey in executive health optimization.
        </p>

        <div className="space-y-8">
          {resources.map((category, categoryIndex) => (
            <div key={categoryIndex}>
              <h3 className="text-2xl font-bold mb-6">{category.category}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {category.items.map((item, itemIndex) => (
                  <Card key={itemIndex} className="mb-6 overflow-hidden flex flex-col">
                    <div className="p-6 flex flex-col flex-grow">
                      {/* Image Section - Above Title */}
                      {item.image && (
                        <div className="w-full h-48 mb-4 flex justify-center">
                          <img 
                            src={item.image} 
                            alt={item.title}
                            className="h-full object-contain rounded-lg shadow-md"
                          />
                        </div>
                      )}
                      
                      {/* Title */}
                      <h3 className="text-lg font-semibold mb-2">{item.title}</h3>
                      <div className="flex items-center justify-between mb-4">
                        <p className="text-sm text-muted-foreground">by {item.author}</p>
                        <div className="flex items-center gap-1 pr-6">
                          {renderStars(item.rating)}
                        </div>
                      </div>
                      
                      {/* Description */}
                      <p className="text-muted-foreground mb-4 text-sm leading-relaxed flex-grow">{item.description}</p>
                      
                      {/* Action Button - Fixed at bottom */}
                      <div className="mt-auto pt-4">
                        <a 
                          href={item.link} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-primary font-semibold hover:text-primary/80 transition-colors flex items-center text-sm"
                        >
                          {item.type === "Book" ? "View on Amazon" : item.type === "Podcast" ? "Listen Now" : "Listen to Episode"}
                          <ExternalLink className="h-4 w-4 ml-1" />
                        </a>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>

      </div>
    </section>
  );
};

export default ResourcesSection;
