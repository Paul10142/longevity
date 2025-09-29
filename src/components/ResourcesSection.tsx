import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BookOpen, ExternalLink, Star } from "lucide-react";

const ResourcesSection = () => {
  const resources = [
    {
      category: "Essential Reading",
      items: [
        {
          title: "Outlive: The Science and Art of Longevity",
          author: "Peter Attia, MD",
          description: "The definitive guide to longevity medicine and optimizing healthspan.",
          type: "Book",
          rating: 5,
          link: "#"
        },
        {
          title: "The Longevity Diet",
          author: "Valter Longo, PhD",
          description: "Evidence-based nutrition strategies for longevity and disease prevention.",
          type: "Book",
          rating: 5,
          link: "#"
        },
        {
          title: "Why We Sleep",
          author: "Matthew Walker, PhD",
          description: "The critical importance of sleep for health, performance, and longevity.",
          type: "Book",
          rating: 5,
          link: "#"
        }
      ]
    },
    {
      category: "Research & Studies",
      items: [
        {
          title: "Blue Zones Research",
          author: "National Geographic",
          description: "Study of the world's longest-lived populations and their lifestyle factors.",
          type: "Research",
          rating: 5,
          link: "#"
        },
        {
          title: "Framingham Heart Study",
          author: "NIH",
          description: "Longitudinal study on cardiovascular disease and lifestyle factors.",
          type: "Research",
          rating: 5,
          link: "#"
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
        <h2 className="text-3xl font-bold tracking-tight mb-8">Curated Resources</h2>
        <p className="text-xl text-muted-foreground mb-8">
          Evidence-based books, research, and tools to deepen your understanding 
          of longevity and lifestyle medicine.
        </p>

        <div className="space-y-8">
          {resources.map((category, categoryIndex) => (
            <div key={categoryIndex}>
              <h3 className="text-2xl font-bold mb-6">{category.category}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {category.items.map((item, itemIndex) => (
                  <Card key={itemIndex} className="mb-6">
                    <CardHeader>
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center">
                          <BookOpen className="h-5 w-5 text-primary mr-2" />
                          <span className="text-sm font-medium text-primary">{item.type}</span>
                        </div>
                        <div className="flex items-center">
                          {renderStars(item.rating)}
                        </div>
                      </div>
                      
                      <CardTitle className="text-lg">{item.title}</CardTitle>
                      <p className="text-sm text-muted-foreground">by {item.author}</p>
                    </CardHeader>
                    <CardContent className="text-base space-y-4">
                      <p className="text-muted-foreground">{item.description}</p>
                      
                      <button className="text-primary font-semibold hover:text-primary/80 transition-colors flex items-center">
                        Learn More
                        <ExternalLink className="h-4 w-4 ml-1" />
                      </button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Newsletter Signup */}
        <Card className="mt-16">
          <CardHeader>
            <CardTitle className="text-2xl">Stay Updated on Longevity Research</CardTitle>
          </CardHeader>
          <CardContent className="text-base space-y-4">
            <p className="text-muted-foreground">
              Get the latest research, tips, and insights delivered to your inbox monthly.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 max-w-md">
              <input
                type="email"
                placeholder="Enter your email"
                className="flex-1 px-4 py-3 rounded-lg text-foreground placeholder-muted-foreground border border-input"
              />
              <button className="bg-[#60a5fa] text-white px-6 py-3 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors">
                Subscribe
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
};

export default ResourcesSection;
