import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, CheckCircle, Target, Zap, Moon, Brain, Pill } from "lucide-react";

const ExecutiveTips = () => {
  const habitTips = [
    "Identity first: 'I'm the type of person who doesn't miss workouts'",
    "Implementation intentions: 'I will [behavior] at [time] in [location]'",
    "Habit stacking: After a current habit, then the new one",
    "Two-minute rule: Make the first step ≤2 minutes",
    "Make it obvious: Put equipment where you'll see it",
    "Make it easy: Lower friction, prepare in advance",
    "Make it satisfying: Track streaks, small rewards",
    "Temptation bundling: Pair 'want' + 'should'",
    "Never miss twice: If today derails, tomorrow is a reset"
  ];

  const exerciseStats = {
    title: "Why Exercise Matters",
    stat: "80% lower mortality",
    description: "Those with elite cardiorespiratory fitness had ~80% lower mortality than 'low' performers. No upper limit to benefit."
  };

  const weeklyTemplate = {
    zone2: "3–5 hrs/week total (30–60 min most days)",
    vo2max: "1 session/week (4–8 repeats of 1–3 minutes hard)",
    strength: "2–4 days/week (push, pull, hinge, squat, carry, core)",
    stability: "5–10 min/session (hips, ankles, T-spine + balance)"
  };

  const nutritionAnchors = [
    "Protein: ~1.2–1.6 g/kg/day (up to 2.2 g/kg if training hard)",
    "Fiber: 25–38 g/day (increase gradually and hydrate)",
    "Minimize ultra-processed 'hyper-palatables'",
    "Plates: ½ veggies/fruit, ¼ protein, ¼ starch/whole grains",
    "Fats: olive oil, nuts, seeds, avocado, fatty fish 2×/week"
  ];

  const sleepToolkit = [
    "AM light: 2–10 min outdoors soon after waking",
    "PM light: dim lights 1–2 h pre-bed",
    "Caffeine cutoff: 8–10 h before bed",
    "Wind-down: same sequence nightly",
    "Cooler room; warm shower 1–2 h pre-bed",
    "3–2–1 rule: ~3h no large meals, ~2h no intense work, ~1h screens down"
  ];

  const supplements = [
    { name: "Creatine monohydrate", dose: "3–5 g/day", note: "Supports strength and cognition" },
    { name: "Vitamin D", dose: "Test and treat if deficient", note: "Individualized with clinician" },
    { name: "Omega-3s", dose: "Favor fish intake", note: "Prescription EPA for high triglycerides" }
  ];

  const workoutChannels = [
    { name: "K boges", type: "Calisthenics", url: "https://www.youtube.com/@Kboges/featured" },
    { name: "Iron Wolf", type: "Calisthenics", url: "https://www.youtube.com/@IronWolf84" },
    { name: "Sydney Cummings Houdyshell", type: "Full body & Cardio", url: "https://www.youtube.com/@sydneycummingshoudyshell/videos" },
    { name: "Body Project", type: "Full body", url: "https://www.youtube.com/@BodyProjectchallenge/videos" },
    { name: "Yoga with Adriene", type: "Yoga", url: "https://www.youtube.com/@yogawithadriene" },
    { name: "Jeff Nippard", type: "Weight lifting", url: "https://www.youtube.com/@JeffNippard" },
    { name: "Will Tennyson", type: "Weight lifting", url: "https://www.youtube.com/@WillTennyson/videos" },
    { name: "Ryan Humiston", type: "Weight lifting", url: "https://www.youtube.com/@RyanHumiston/videos" },
    { name: "Eugene Teo", type: "Weight lifting", url: "https://www.youtube.com/@coacheugeneteo/videos" }
  ];

  const quickWorkouts = [
    { name: "5 min Warmup (Iron Wolf)", duration: "5 min", url: "https://www.youtube.com/watch?v=myR8AukBwRQ&list=PL6qXL4xeBwT8GHFXpmY7eWcFH8_NYq74N&index=12" },
    { name: "30 min Stretching/Flexibility Routine (Tykato Fitness)", duration: "30 min", url: "https://www.youtube.com/watch?v=VVPyAU4l-sw&list=PL6qXL4xeBwT8GHFXpmY7eWcFH8_NYq74N&index=9" },
    { name: "Bodyweight 15 minute workout (Iron Wolf)", duration: "15 min", url: "https://www.youtube.com/watch?v=XNc0Iu1VZTg" },
    { name: "Beginner Bodyweight Workout (Strength Side)", duration: "15 min", url: "https://www.youtube.com/watch?v=rM-Cw_vWGPE" },
    { name: "StewSmith Travel Workout", duration: "Variable", url: "http://www.stewsmith.com/linkpages/travelworkout.htm" },
    { name: "20 Min Beginner Yoga Workout (Yoga With Adrienne)", duration: "20 min", url: "https://www.youtube.com/watch?v=v7AYKMP6rOE&list=PL6qXL4xeBwT8GHFXpmY7eWcFH8_NYq74N&index=4&t=588s&pp=gAQBiAQB" },
    { name: "20-Minute Cardio Jump Rope Workout (TIFF x Dan)", duration: "20 min", url: "https://www.youtube.com/watch?v=DTdaiqR9now" },
    { name: "25 MIN FULL BODY HIIT for Beginners (growingannanas)", duration: "25 min", url: "https://www.youtube.com/watch?v=cbKkB3POqaY" },
    { name: "30 Minute HIIT Cardio Workout (SELF)", duration: "30 min", url: "https://www.youtube.com/watch?v=ml6cT4AZdqI" },
    { name: "30-Minute Home Pilates Workout (Move with Nicole)", duration: "30 min", url: "https://www.youtube.com/watch?v=C2HX2pNbUCM" },
    { name: "JimWendler Boring But Big 5-3-1 Lifting Program", duration: "Program", url: "https://www.jimwendler.com/blogs/jimwendler-com/101077382-boring-but-big" },
    { name: "JimWendler 5-3-1 Spreadsheet", duration: "Tool", url: "https://docs.google.com/spreadsheets/d/1wdyKcA8AUC6UZBJLTHNCScooyq0cyPpIr1cDRCm-f_0/edit?gid=1952315040#gid=1952315040" }
  ];

  const bigTakeaways = [
    "The current system isn't designed to beat chronic disease—you must be the captain",
    "Six big levers: sleep, exercise, nutrition, mental health, drugs/supps, surgery/medical care",
    "Prioritize the majors; don't major in the minors",
    "Use Atomic Habits tactics so the plan actually happens",
    "It's hard—and that's normal. Design your environment so success is the default"
  ];

  return (
    <section id="tips" className="py-8 lg:py-12 bg-primary/5">
      <div className="container">
        <h2 className="text-3xl font-bold tracking-tight mb-8">Longevity Toolkit</h2>
        <p className="text-xl text-muted-foreground mb-8">
          Evidence-informed, action-first strategies for building sustainable health habits. 
          Start with one habit per domain and track for 14 days.
        </p>

        <div className="space-y-8">
          {/* Big Takeaways - Moved to top */}
          <Card className="border-l-4 border-l-yellow-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">🎯</span>
                <h3 className="text-2xl font-semibold">Your 5 Big Takeaways</h3>
              </div>
              <div className="space-y-3">
                {bigTakeaways.map((takeaway, index) => (
                  <div key={index} className="flex items-start gap-3">
                    <Badge variant="outline" className="mt-0.5">{index + 1}</Badge>
                    <span className="text-sm">{takeaway}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* How to Actually Change */}
          <Card className="border-l-4 border-l-blue-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">🎯</span>
                <h3 className="text-2xl font-semibold">How to Actually Change (Atomic Habits, Fast Version)</h3>
              </div>
              <p className="text-muted-foreground mb-4">
                The best plan is the one you'll do consistently. Use these tiny levers to make that happen:
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {habitTips.map((tip, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <span className="text-sm">{tip}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Exercise */}
          <Card className="border-l-4 border-l-orange-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">💪</span>
                <h3 className="text-2xl font-semibold">Exercise (Strength • Zone 2 • Stability)</h3>
              </div>
              
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-6">
                <h4 className="font-semibold text-orange-800 mb-2">{exerciseStats.title}</h4>
                <p className="text-orange-700">
                  <span className="font-bold text-2xl">{exerciseStats.stat}</span> - {exerciseStats.description} There is no upper limit to the benefit.
                </p>
              </div>

              <h4 className="font-semibold mb-3">Weekly "Minimum Viable" Template:</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">Zone 2</Badge>
                    <span className="text-sm">{weeklyTemplate.zone2}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">VO₂max</Badge>
                    <span className="text-sm">{weeklyTemplate.vo2max}</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">Strength</Badge>
                    <span className="text-sm">{weeklyTemplate.strength}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">Stability</Badge>
                    <span className="text-sm">{weeklyTemplate.stability}</span>
                  </div>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="font-semibold mb-2">Beginner-Friendly 2-Day Strength Split (Machine-Based):</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <h5 className="font-medium text-sm mb-1">Day A:</h5>
                    <p className="text-sm text-muted-foreground">Leg press • Seated row • Chest press machine • Leg curl • Plank (30-60 sec)</p>
                  </div>
                  <div>
                    <h5 className="font-medium text-sm mb-1">Day B:</h5>
                    <p className="text-sm text-muted-foreground">Leg extension • Lat pulldown • Shoulder press machine • Hip abduction • Wall sit (30-60 sec)</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">Start with 2 sets of 8-12 reps, focus on form over weight</p>
              </div>
            </CardContent>
          </Card>

          {/* Workout Resources */}
          <Card className="border-l-4 border-l-red-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">📺</span>
                <h3 className="text-2xl font-semibold">Follow-Along Videos & Channels</h3>
              </div>
              
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                  <h4 className="font-semibold mb-3">Workout YouTube Channels</h4>
                  <div className="space-y-2">
                    {workoutChannels.map((channel, index) => (
                      <div key={index} className="flex items-center justify-between p-2 border rounded">
                        <div>
                          <span className="font-medium">{channel.name}</span>
                          <span className="text-sm text-muted-foreground ml-2">({channel.type})</span>
                        </div>
                        <a href={channel.url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
                
                <div>
                  <h4 className="font-semibold mb-3">Quick Workouts</h4>
                  <div className="space-y-2">
                    {quickWorkouts.map((workout, index) => (
                      <div key={index} className="flex items-center justify-between p-2 border rounded">
                        <div>
                          <span className="font-medium">{workout.name}</span>
                          <span className="text-sm text-muted-foreground ml-2">({workout.duration})</span>
                        </div>
                        <a href={workout.url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Quick Start */}
          <Card className="border-l-4 border-l-green-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">🚀</span>
                <h3 className="text-2xl font-semibold">Quick "Start Here" for Busy Weeks</h3>
              </div>
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <h4 className="font-semibold mb-2">Mon, Wed, Fri:</h4>
                    <p>30–45 min strength (split A/B), each with a 10–20 min Zone 2 warm-up/finish</p>
                  </div>
                  <div>
                    <h4 className="font-semibold mb-2">Tue, Thu, Sat:</h4>
                    <p>30–60 min Zone 2 or ruck/walk</p>
                  </div>
                  <div>
                    <h4 className="font-semibold mb-2">Daily:</h4>
                    <p>5–10 min mobility, 7–9 h sleep routine, protein+fiber at each meal</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Nutrition */}
          <Card className="border-l-4 border-l-green-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">🥗</span>
                <h3 className="text-2xl font-semibold">Nutrition (Simple, Filling, Sustainable)</h3>
              </div>
              
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
                <h4 className="font-semibold text-green-800 mb-2">North Star</h4>
                <p className="text-green-700">
                  Eat mostly minimally processed foods you enjoy, high in protein + fiber, and aligned with your life.
                </p>
              </div>

              <h4 className="font-semibold mb-3">Daily Anchors:</h4>
              <div className="space-y-2">
                {nutritionAnchors.map((anchor, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <span className="text-sm">{anchor}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Sleep */}
          <Card className="border-l-4 border-l-purple-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">😴</span>
                <h3 className="text-2xl font-semibold">Sleep (Foundation for Everything)</h3>
              </div>
              
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-6">
                <p className="text-purple-700 font-medium">
                  Target: 7–9 hours for most adults; protect regularity and light exposure
                </p>
              </div>

              <h4 className="font-semibold mb-3">Huberman-Inspired Toolkit:</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {sleepToolkit.map((tip, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-purple-500 mt-0.5 flex-shrink-0" />
                    <span className="text-sm">{tip}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Mental Health */}
          <Card className="border-l-4 border-l-pink-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">🧠</span>
                <h3 className="text-2xl font-semibold">Mental Health (Performance Multiplier)</h3>
              </div>
              <div className="space-y-3">
                <p>• Protect the basics first (sleep, movement, sunlight, real food, social contact)</p>
                <p>• Spend time in nature regularly</p>
                <p>• Spend time with friends, family, and loved ones</p>
                <p>• Try to reduce stress as much as realistically possible</p>
                <p>• Have some sort of thing that you enjoy doing that you regularly engage in</p>
                <p>• Minimize time on electronics, especially social media</p>
                <p>• Sleep is a very big impact</p>
                <p>• Try a 5–10 minute daily check-in: write "What went well? What's tough? One next step."</p>
                <p>• If symptoms persist, consider therapy/meds—getting help is strength</p>
              </div>
              </CardContent>
            </Card>

          {/* Supplements */}
          <Card className="border-l-4 border-l-blue-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">💊</span>
                <h3 className="text-2xl font-semibold">Drugs & Supplements (Don't Major in the Minors)</h3>
              </div>
              <p className="text-muted-foreground mb-4">
                Focus on sleep, exercise, nutrition first. Here are a few supplements with decent support:
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {supplements.map((supp, index) => (
                  <div key={index} className="border rounded-lg p-3">
                    <div className="mb-1">
                      <span className="font-medium">{supp.name}</span>
                      <span className="text-sm text-muted-foreground ml-1">({supp.dose})</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{supp.note}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

        </div>
      </div>
    </section>
  );
};

export default ExecutiveTips;
