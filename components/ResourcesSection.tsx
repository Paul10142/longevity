import { Card } from "@/components/ui/card";
import { ExternalLink, Star } from "lucide-react";
import Image from "next/image";

// Import local images
import outliveImage from "@/assets/outlive.jpg";
import atomicHabitsImage from "@/assets/atomic habits.jpg";
import goodEnergyImage from "@/assets/good energy.jpg";
import theDriveImage from "@/assets/thedrive podcast.jpg";
import foundMyFitnessImage from "@/assets/foundmyfitness podcast.jpeg";
import hubermanLabImage from "@/assets/hubmanlabpodcast.jpeg";
import performImage from "@/assets/performandygalpin podcast.jpg";
import modernWisdomImage from "@/assets/modern wisdom podcast.jpeg";
import timFerrissImage from "@/assets/tim ferriss show podcast.jpeg";

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
          image: outliveImage,
          featured: true
        },
        {
          title: "Atomic Habits: An Easy & Proven Way to Build Good Habits & Break Bad Ones",
          author: "James Clear",
          description: "A comprehensive guide to building better habits and breaking bad ones. This book provides practical strategies for creating lasting behavior change through small, incremental improvements.",
          type: "Book",
          rating: 5,
          link: "https://www.amazon.com/Atomic-Habits-Proven-Build-Break/dp/0735211299",
          image: atomicHabitsImage
        },
        {
          title: "Good Energy: The Surprising Connection Between Metabolism and Limitless Health",
          author: "Dr. Casey Means and Calley Means",
          description: "Focuses specifically on the global impact of metabolic health on all of the body systems, as well as the role of environmental factors on lifestyle and overall health.",
          type: "Book",
          rating: 5,
          link: "https://www.amazon.com/Good-Energy-Surprising-Connection-Metabolism/dp/0593712641",
          image: goodEnergyImage
        }
      ]
    },
    {
      category: "Awesome Health-Focused Podcasts",
      items: [
        {
          title: "The Drive – Peter Attia MD",
          author: "Peter Attia, MD",
          description: "My favorite podcast. Dr. Attia meets with a variety of experts across various disciplines, not only focusing on biochemistry and medical science, but also mental health and happiness. Almost every episode has me stop what I'm doing multiple times and think, 'Holy crap, I never knew this.'",
          type: "Podcast",
          rating: 5,
          link: "https://peterattiamd.com/podcast/",
          image: theDriveImage
        },
        {
          title: "FoundMyFitness – Rhonda Patrick PhD",
          author: "Rhonda Patrick, PhD",
          description: "Similar to The Drive in that it goes deep on the clinical side and has a variety of expert guests. Often leans slightly towards physical activity and exercise protocols, which is nice.",
          type: "Podcast",
          rating: 5,
          link: "https://www.foundmyfitness.com/",
          image: foundMyFitnessImage
        },
        {
          title: "Huberman Lab Podcast – Andrew Huberman PhD",
          author: "Andrew Huberman, PhD",
          description: "Engaging and geared more toward a mass audience (vs. clinician focus) and doesn't always go as deep into the science. Each episode offers protocols you can implement in your life.",
          type: "Podcast",
          rating: 5,
          link: "https://www.hubermanlab.com/",
          image: hubermanLabImage
        },
        {
          title: "Perform with Dr. Andy Galpin, PhD",
          author: "Dr. Andy Galpin, PhD",
          description: "A newer podcast by an exercise scientist and performance coach who works with top athletes nationwide. More focused on exercise and athletics but also covers nutrition and supplements.",
          type: "Podcast",
          rating: 5,
          link: "https://performpodcast.com/",
          image: performImage
        }
      ]
    },
    {
      category: "Specific Interesting Episodes",
      items: [
        {
          title: "How Metabolic & Immune System Dysfunction Drive the Aging Process",
          author: "The Drive – Episode #359",
          description: "Comprehensive exploration of how metabolic dysfunction and immune system changes contribute to the aging process and what we can do about it.",
          type: "Episode",
          rating: 5,
          link: "https://peterattiamd.com/podcast/",
          image: theDriveImage
        },
        {
          title: "The Science of Resistance Training, Building Muscle & Anabolic Use",
          author: "The Drive – Episode #335",
          description: "Deep dive into the science of resistance training, muscle building, and the role of anabolic compounds in performance and longevity.",
          type: "Episode",
          rating: 5,
          link: "https://peterattiamd.com/podcast/",
          image: theDriveImage
        },
        {
          title: "Longevity 101: A Foundational Guide to Peter's Frameworks for Longevity",
          author: "The Drive – Episode #311",
          description: "Essential foundational episode covering Peter's core frameworks and approaches to longevity, perfect for newcomers to the field.",
          type: "Episode",
          rating: 5,
          link: "https://peterattiamd.com/podcast/",
          image: theDriveImage
        },
        {
          title: "Injury Prevention, Recovery, and Performance Optimization for Every Decade",
          author: "The Drive – Episode #350",
          description: "Comprehensive guide to injury prevention, recovery strategies, and performance optimization tailored for different age groups and life stages.",
          type: "Episode",
          rating: 5,
          link: "https://peterattiamd.com/podcast/",
          image: theDriveImage
        },
        {
          title: "Dr. Ben Bikman: How To Reverse Insulin Resistance Through Diet, Exercise, & Sleep",
          author: "FoundMyFitness – Episode #104",
          description: "Deep dive into insulin resistance and practical strategies for reversal through lifestyle interventions.",
          type: "Episode",
          rating: 5,
          link: "https://www.foundmyfitness.com/episodes/ben-bikman",
          image: foundMyFitnessImage
        },
        {
          title: "Dr. Keith Baar: Simple Exercises That Can Repair Tendons, Collagen Fact vs. Fiction",
          author: "The Tim Ferriss Show – Episode #797",
          description: "Comprehensive look at tendon repair, collagen science, and the anti-RICE protocol for injury recovery.",
          type: "Episode",
          rating: 5,
          link: "https://tim.blog/2025/02/26/dr-keith-baar/",
          image: timFerrissImage
        },
        {
          title: "Dr. Andy Galpin: The Optimal Diet, Supplement, & Recovery Protocol for Peak Performance",
          author: "FoundMyFitness – Episode #101",
          description: "Evidence-based protocols for nutrition, supplementation, and recovery strategies for optimal performance.",
          type: "Episode",
          rating: 5,
          link: "https://www.foundmyfitness.com/episodes/andy-galpin",
          image: foundMyFitnessImage
        },
        {
          title: "Max Lugavere – The Terrifying Link Between Diet & Mental Health",
          author: "Modern Wisdom – Episode #709",
          description: "Explores the critical connection between nutrition and mental health, with actionable insights for cognitive optimization.",
          type: "Episode",
          rating: 5,
          link: "https://podcasts.apple.com/za/podcast/709-max-lugavere-the-terrifying-link-between-diet/id1347973549?i=1000635388383",
          image: modernWisdomImage
        },
        {
          title: "Nsima Inyang - True Athleticism at Any Age, Microdosing Movement, 'Rope Flow' as a Key Unlock, Why Sleds and Sandbags Matter, and Much More",
          author: "The Tim Ferriss Show – Episode #816",
          description: "Comprehensive discussion on athleticism, movement patterns, and unconventional training methods that can benefit people of all ages.",
          type: "Episode",
          rating: 5,
          link: "https://tim.blog/2025/06/19/nsima-inyang/",
          image: timFerrissImage
        },
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
    <section id="resources" className="py-16 sm:py-20 lg:py-24 bg-background">
      <div className="container">
        <div className="max-w-4xl mx-auto mb-16 text-center">
          <h2 className="text-4xl sm:text-5xl font-sans font-semibold tracking-tight mb-6 text-primary">Next Steps for Learning</h2>
          <p className="text-xl sm:text-2xl text-muted-foreground leading-relaxed font-light">
            Curated books, podcasts, and episodes to deepen your understanding of longevity and lifestyle medicine. These are the resources that have shaped my own journey into lifestyle medicine, and offer a great starting point to learning more about the subject!
          </p>
        </div>

        <div className="max-w-7xl mx-auto space-y-12 sm:space-y-16">
          {resources.map((category, categoryIndex) => (
            <div key={categoryIndex}>
              <h3 className="text-2xl sm:text-3xl font-sans font-semibold mb-8 text-primary border-b border-border/50 pb-4">{category.category}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8">
                {category.items.map((item, itemIndex) => (
                  <Card 
                    key={itemIndex} 
                    className={`overflow-hidden flex flex-col shadow-premium hover:shadow-premium-lg transition-all duration-300 transform hover:-translate-y-1 border-2 ${
                      'featured' in item && item.featured 
                        ? 'border-accent ring-2 ring-accent/20 bg-gradient-to-br from-background to-accent/5' 
                        : 'border-border/50 bg-gradient-to-br from-background to-muted/20'
                    }`}
                  >
                    <div className="p-6 flex flex-col flex-grow">
                      {/* Image and Title Section */}
                      {'image' in item && item.image && (
                        <div className="flex flex-col gap-4 mb-4">
                          <div className="flex-shrink-0 relative w-full aspect-square max-w-[200px] mx-auto">
                            <Image 
                              src={item.image} 
                              alt={item.title}
                              fill
                              className="object-contain rounded-lg shadow-md"
                            />
                          </div>
                          <div className="flex-1 min-w-0 text-center">
                            <h3 className="text-lg font-sans font-semibold mb-2 leading-tight text-primary">{item.title}</h3>
                            <div className="mb-3">
                              <p className="text-sm text-muted-foreground mb-2">by {item.author}</p>
                              <div className="flex items-center justify-center gap-1">
                                {renderStars(item.rating)}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                      
                      {/* Description */}
                      <p className="text-muted-foreground mb-4 text-sm leading-relaxed flex-grow">{item.description}</p>
                      
                      {/* Action Button */}
                      <div className="mt-auto pt-4 border-t border-border/50">
                        <a 
                          href={item.link} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-primary font-semibold hover:text-primary/80 transition-all duration-200 flex items-center justify-center text-sm group"
                        >
                          {item.type === "Book" ? "View on Amazon" : item.type === "Podcast" ? "Listen Now" : "Listen to Episode"}
                          <ExternalLink className="h-4 w-4 ml-2 group-hover:translate-x-1 transition-transform" />
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
