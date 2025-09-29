import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock, Target, TrendingUp, Users, Brain, Zap } from "lucide-react";

const ExecutiveTips = () => {
  const tips = [
    {
      icon: <Clock className="h-6 w-6" />,
      title: "Time Management for Health",
      description: "Optimize your schedule to include movement, nutrition, and recovery without sacrificing productivity.",
      action: "Download Time Blocking Template"
    },
    {
      icon: <Target className="h-6 w-6" />,
      title: "Goal Setting Framework",
      description: "Set measurable health goals that align with your professional objectives and personal values.",
      action: "Access SMART Goals Worksheet"
    },
    {
      icon: <TrendingUp className="h-6 w-6" />,
      title: "Performance Metrics",
      description: "Track key biomarkers and lifestyle factors that directly impact your cognitive and physical performance.",
      action: "Get Biomarker Checklist"
    },
    {
      icon: <Users className="h-6 w-6" />,
      title: "Team Health Culture",
      description: "Lead by example and create a workplace culture that prioritizes employee health and longevity.",
      action: "Download Team Health Guide"
    },
    {
      icon: <Brain className="h-6 w-6" />,
      title: "Cognitive Optimization",
      description: "Enhance focus, memory, and decision-making through evidence-based lifestyle interventions.",
      action: "Get Brain Health Protocol"
    },
    {
      icon: <Zap className="h-6 w-6" />,
      title: "Energy Management",
      description: "Sustain high energy levels throughout the day using strategic nutrition, movement, and recovery techniques.",
      action: "Access Energy Protocol"
    }
  ];

  return (
    <section id="tips" className="py-8 lg:py-12 bg-primary/5">
      <div className="container">
        <h2 className="text-3xl font-bold tracking-tight mb-8">Executive Health Toolkit</h2>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {tips.map((tip, index) => (
            <Card key={index} className="mb-6">
              <CardHeader>
                <div className="flex items-center mb-4">
                  <div className="bg-primary/10 text-primary p-2 rounded-lg mr-3">
                    {tip.icon}
                  </div>
                  <CardTitle className="text-lg">{tip.title}</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="text-base space-y-4">
                <p className="text-muted-foreground">{tip.description}</p>
                <button className="text-primary font-semibold hover:text-primary/80 transition-colors">
                  {tip.action} →
                </button>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Featured Resource */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="text-2xl">Executive Longevity Playbook</CardTitle>
          </CardHeader>
          <CardContent className="text-base space-y-4">
            <p className="text-muted-foreground">
              A comprehensive 30-page guide covering nutrition, exercise, sleep, stress management, 
              and biomarker optimization specifically tailored for executive lifestyles.
            </p>
            <button className="bg-[#60a5fa] text-white px-8 py-3 rounded-lg font-semibold hover:bg-[#3b82f6] transition-colors">
              Download Complete Playbook
            </button>
          </CardContent>
        </Card>
      </div>
    </section>
  );
};

export default ExecutiveTips;
