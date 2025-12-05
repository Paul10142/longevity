import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, CheckCircle } from "lucide-react";

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
    stat: "400% lower mortality",
    description: "Those with elite cardiorespiratory fitness (measured by the top percentile of VO2 max) had a 400% lower all-cause mortality than the lowest percentile. There was no upper limit to this benefit!"
  };

  const weeklyTemplate = {
    zone2: "3–5 hrs/week total (30–60 min most days)",
    vo2max: "1 session/week (4–8 repeats of 1–3 minutes hard)",
    strength: "2–4 days/week (push, pull, hinge, squat, carry, core)",
    stability: "5–10 min/session (hips, ankles, T-spine + balance)"
  };

  const nutritionAnchors = [
    "Aim for protein up to 1g/lb of bodyweight/day. This requires you to be very intentional, and will create diet that keeps you full throughout the day. Some people find they lose weight just from this alone.",
    "Plates: ½ veggies/fruit, ¼ protein, ¼ starch/whole grains",
    "Fats: olive oil, nuts, seeds, avocado, fatty fish 2×/week",
    "When possible, cook food at home. You know exactly what ingredients and what portions you're using. If you're busy, consider meal prepping (make one big batch of food) to eat throughout the week.",
    "When you look at your plate/portions, reduce the amount of refined carbohydrates (like bread, pasta, rice) and substitue for more meats/fruits/veggies",
    "Some people can be sensitive to dairy and gluten and have no idea. If you're able to, it could be useful to cut these food groups out for 2 weeks and see if you notice and change in the way you're feeling, your energy levels, and bloating/bowel habits.",
    "Low-fat diets used to be the fad, but in hindsight that was likely due to marketing and lobbying by the food industry. Instead aim to minimize processed and refined sugar/carbohydrates, and don't be afraid to try out healthy types of fat such as olive oil, nuts, seeds, avocado, and fatty fish."
  ];

  const sleepToolkit = [
    "Create a better circadian rhythm - try to get light exposure when you wake up, and as much as possible go to bed and wake up at similar times each day",
    "3–2–1 rule: ~3h before bed stop eating, ~2h stop drinking, ~1h minimize phone/electronics",
    "Reduce light in the evening 1-2 hr before bedtime, especially overhead lighting. Consider a light dimmer/red light to signal to your brain that it's time for bed.",
    "Wind-down: same sequence nightly",
    "Reduce caffeine intake 10-12 hours before bedtime",
    "Make your bedroom cool and dark - aim for 65º F, and use blackout curtains/electrical tape/eye mask to minimize light",
    "If you snore or breathe loudly, it might be indicative of an underlying issue. Talk to your doctor, consider a sleep study, and think about other tools (mouth tape, side sleeping instead of back sleeping, raising the head of the bed so you're partially upright)"
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
    "Our current medical system wasn't designed to adequately treat chronic disease",
    "The six big levers of health that our within our control are sleep, exercise, nutrition, mental health, drugs & supplements, and surgery/medical interventions",
    "You MUST be involved in your own healthcare. This is going to take work - educating yourself about this topic, putting in effort to make changes, and staying on top of your medical appointments + developing an interactive relationship with your physician. Instead of being a passenger in your body, you need to be the captain - NOBODY can do this for you.",
    "Focus on the low-hanging fruit in healthier sleep, exercise, and nutrition habits. It's easily to make this overcomplicated, but the basics will get you 90% of the way there!",
    "Lifestyle change is HARD - and that's completely normal. Give yourself grace and don't be too hard on yourself, and consider behavioral habits that will make it easier to see change."
  ];

  return (
    <section id="tips" className="py-16 sm:py-20 lg:py-24 bg-gradient-to-b from-background via-muted/30 to-background">
      <div className="container">
        <div className="max-w-4xl mx-auto mb-16 text-center">
          <h2 className="text-4xl sm:text-5xl font-sans font-semibold tracking-tight mb-6 text-primary">Longevity Toolkit</h2>
          <p className="text-xl sm:text-2xl text-muted-foreground leading-relaxed font-light">
            Evidence-informed, action-first strategies for building sustainable health habits. 
            Start with one habit per domain and track for 14 days.
          </p>
        </div>

        <div className="max-w-5xl mx-auto space-y-8 sm:space-y-10">
          {/* Big Takeaways - Moved to top */}
          <Card className="border-l-4 border-l-accent shadow-premium overflow-hidden bg-gradient-to-br from-background to-muted/20">
            <CardContent className="p-8 sm:p-10">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center">
                  <span className="text-2xl">🎯</span>
                </div>
                <h3 className="text-2xl sm:text-3xl font-sans font-semibold text-primary">The Big 5 Ideas You Need to Take Away</h3>
              </div>
              <div className="space-y-4">
                {bigTakeaways.map((takeaway, index) => (
                  <div key={index} className="flex items-start gap-4 p-4 rounded-lg bg-muted/30 border border-border/50 hover:bg-muted/50 transition-colors">
                    <Badge variant="outline" className="mt-0.5 min-w-[2rem] h-8 flex items-center justify-center font-semibold border-accent/50 text-accent-foreground bg-accent/10">{index + 1}</Badge>
                    <span className="text-base leading-relaxed pt-1">{takeaway}</span>
                  </div>
                ))}
              </div>
              
              <div className="bg-accent/10 border border-accent/30 rounded-lg p-6 mt-8">
                <p className="text-foreground leading-relaxed">
                  <strong className="font-semibold">Remember -</strong> your doctors, medical professionals, and healthcare system really do want the best for you and are doing the best they can with the system we have. Medical, pharmacologic, and surgical advancements have changed the face of civilization for the better.
                </p>
                <p className="text-foreground mt-4 leading-relaxed">
                  That doesn't mean we should ignore the importance of lifestyle changes, but also doesn't mean that drugs and traditional medical interventions are "bad" and that "unnatural" remedies aren't still extremely important!
                </p>
              </div>
            </CardContent>
          </Card>

          {/* How to Actually Change */}
          <Card className="border-l-4 border-l-primary shadow-premium overflow-hidden bg-gradient-to-br from-background to-muted/20">
            <CardContent className="p-8 sm:p-10">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-2xl">🎯</span>
                </div>
                <h3 className="text-2xl sm:text-3xl font-sans font-semibold text-primary">First Steps to Changing Your Behavior</h3>
              </div>
              <p className="text-muted-foreground mb-6 text-lg leading-relaxed">
                The way to change behavior is to form a small habit that you'll do consistently. Use these tiny levers to make that happen:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {habitTips.map((tip, index) => (
                  <div key={index} className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border/50 hover:bg-muted/50 transition-colors">
                    <CheckCircle className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                    <span className="text-base leading-relaxed">{tip}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Sleep */}
          <Card className="border-l-4 border-l-primary/60 shadow-premium overflow-hidden bg-gradient-to-br from-background to-muted/20">
            <CardContent className="p-8 sm:p-10">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-2xl">😴</span>
                </div>
                <h3 className="text-2xl sm:text-3xl font-sans font-semibold text-primary">Sleep (Foundation for Everything)</h3>
              </div>
              
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-5 mb-8">
                <p className="text-foreground font-semibold text-lg">
                  Target: 7–9 hours for most adults; protect regularity and light exposure
                </p>
              </div>

              <h4 className="font-semibold mb-4 text-lg">General Toolkit:</h4>
              <div className="columns-1 sm:columns-2 gap-6 space-y-3">
                {sleepToolkit.map((tip, index) => (
                  <div key={index} className="flex items-start gap-3 break-inside-avoid p-3 rounded-lg bg-muted/30 border border-border/50 hover:bg-muted/50 transition-colors">
                    <CheckCircle className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                    <span className="text-base leading-relaxed">{tip}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Exercise */}
          <Card className="border-l-4 border-l-accent/60 shadow-premium overflow-hidden bg-gradient-to-br from-background to-muted/20">
            <CardContent className="p-8 sm:p-10">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center">
                  <span className="text-2xl">💪</span>
                </div>
                <h3 className="text-2xl sm:text-3xl font-sans font-semibold text-primary">Exercise (Strength • Zone 2 • Stability)</h3>
              </div>
              
              <div className="bg-accent/10 border border-accent/30 rounded-lg p-6 mb-8">
                <h4 className="font-semibold text-foreground mb-3 text-lg">{exerciseStats.title}</h4>
                <p className="text-foreground leading-relaxed">
                  <span className="font-bold text-3xl text-accent-foreground">{exerciseStats.stat}</span> - {exerciseStats.description}
                </p>
              </div>

              <h4 className="font-semibold mb-4 text-lg">Weekly "Minimum Viable" Template:</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                <div className="space-y-3">
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border/50">
                    <Badge variant="outline" className="border-primary/50 bg-primary/10 text-primary-foreground">Zone 2</Badge>
                    <span className="text-base leading-relaxed pt-0.5">{weeklyTemplate.zone2}</span>
                  </div>
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border/50">
                    <Badge variant="outline" className="border-primary/50 bg-primary/10 text-primary-foreground">VO₂max</Badge>
                    <span className="text-base leading-relaxed pt-0.5">{weeklyTemplate.vo2max}</span>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border/50">
                    <Badge variant="outline" className="border-primary/50 bg-primary/10 text-primary-foreground">Strength</Badge>
                    <span className="text-base leading-relaxed pt-0.5">{weeklyTemplate.strength}</span>
                  </div>
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border/50">
                    <Badge variant="outline" className="border-primary/50 bg-primary/10 text-primary-foreground">Stability</Badge>
                    <span className="text-base leading-relaxed pt-0.5">{weeklyTemplate.stability}</span>
                  </div>
                </div>
              </div>

            </CardContent>
          </Card>

          {/* Nutrition */}
          <Card className="border-l-4 border-l-primary/60 shadow-premium overflow-hidden bg-gradient-to-br from-background to-muted/20">
            <CardContent className="p-8 sm:p-10">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-2xl">🥗</span>
                </div>
                <h3 className="text-2xl sm:text-3xl font-sans font-semibold text-primary">Nutrition (Simple, Filling, Sustainable)</h3>
              </div>
              
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-6 mb-8">
                <h4 className="font-semibold text-foreground mb-3 text-lg">North Star</h4>
                <p className="text-foreground leading-relaxed">
                  Try to minimize hyper-palatable (addictive) and hyper-processed foods, and switch to minimally processed foods you enjoy (and your tastebuds will change after a couple of months!). The goal isn't to create a new fad diet, but to create a pattern of eating you can stick to for the rest of your life.
                </p>
              </div>

              <h4 className="font-semibold mb-4 text-lg">Daily Anchors:</h4>
              <div className="columns-1 sm:columns-2 gap-6 space-y-3">
                {nutritionAnchors.map((anchor, index) => (
                  <div key={index} className="flex items-start gap-3 break-inside-avoid p-3 rounded-lg bg-muted/30 border border-border/50 hover:bg-muted/50 transition-colors">
                    <CheckCircle className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                    <span className="text-base leading-relaxed">{anchor}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Workout Resources */}
          <Card className="border-l-4 border-l-accent/60 shadow-premium overflow-hidden bg-gradient-to-br from-background to-muted/20">
            <CardContent className="p-8 sm:p-10">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center">
                  <span className="text-2xl">📺</span>
                </div>
                <h3 className="text-2xl sm:text-3xl font-sans font-semibold text-primary">Exercise & Workout Resources</h3>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div>
                  <h4 className="font-semibold mb-4 text-lg">Workout YouTube Channels</h4>
                  <div className="space-y-3">
                    {workoutChannels.map((channel, index) => (
                      <div key={index} className="flex items-center justify-between p-4 border border-border/50 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
                        <div>
                          <span className="font-medium text-foreground">{channel.name}</span>
                          <span className="text-sm text-muted-foreground ml-2">({channel.type})</span>
                        </div>
                        <a href={channel.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80 transition-colors">
                          <ExternalLink className="h-5 w-5" />
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
                
                <div>
                  <h4 className="font-semibold mb-4 text-lg">Quick Workouts</h4>
                  <div className="space-y-3">
                    {quickWorkouts.map((workout, index) => (
                      <div key={index} className="flex items-center justify-between p-4 border border-border/50 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
                        <div>
                          <span className="font-medium text-foreground">{workout.name}</span>
                          <span className="text-sm text-muted-foreground ml-2">({workout.duration})</span>
                        </div>
                        <a href={workout.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80 transition-colors">
                          <ExternalLink className="h-5 w-5" />
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="bg-muted/50 border border-border/50 rounded-lg p-6 mt-8">
                <h4 className="font-semibold mb-4 text-lg">Beginner-Friendly 2-Day Strength Split (Machine-Based):</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div className="p-4 bg-background rounded-lg border border-border/50">
                    <h5 className="font-semibold text-base mb-2">Day A:</h5>
                    <p className="text-base text-muted-foreground leading-relaxed">Leg press • Seated row • Chest press machine • Leg curl • Plank (30-60 sec)</p>
                  </div>
                  <div className="p-4 bg-background rounded-lg border border-border/50">
                    <h5 className="font-semibold text-base mb-2">Day B:</h5>
                    <p className="text-base text-muted-foreground leading-relaxed">Leg extension • Lat pulldown • Shoulder press machine • Hip abduction • Wall sit (30-60 sec)</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-4">Start with 2 sets of 8-12 reps, focus on form over weight</p>
              </div>
            </CardContent>
          </Card>

          {/* Quick Start */}
          <Card className="border-l-4 border-l-accent shadow-premium overflow-hidden bg-gradient-to-br from-background to-muted/20">
            <CardContent className="p-8 sm:p-10">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center">
                  <span className="text-2xl">🚀</span>
                </div>
                <h3 className="text-2xl sm:text-3xl font-sans font-semibold text-primary">Quick "Start Here" for Busy Weeks</h3>
              </div>
              <div className="bg-accent/10 border border-accent/30 rounded-lg p-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 text-base">
                  <div className="p-4 bg-background rounded-lg border border-border/50">
                    <h4 className="font-semibold mb-2 text-foreground">Mon, Wed, Fri:</h4>
                    <p className="text-muted-foreground leading-relaxed">30–45 min strength (split A/B), each with a 10–20 min Zone 2 warm-up/finish</p>
                  </div>
                  <div className="p-4 bg-background rounded-lg border border-border/50">
                    <h4 className="font-semibold mb-2 text-foreground">Tue, Thu, Sat:</h4>
                    <p className="text-muted-foreground leading-relaxed">30–60 min Zone 2 or ruck/walk</p>
                  </div>
                  <div className="p-4 bg-background rounded-lg border border-border/50">
                    <h4 className="font-semibold mb-2 text-foreground">Daily:</h4>
                    <p className="text-muted-foreground leading-relaxed">5–10 min mobility, 7–9 h sleep routine, protein+fiber at each meal</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Mental Health */}
          <Card className="border-l-4 border-l-primary/60 shadow-premium overflow-hidden bg-gradient-to-br from-background to-muted/20">
            <CardContent className="p-8 sm:p-10">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-2xl">🧠</span>
                </div>
                <h3 className="text-2xl sm:text-3xl font-sans font-semibold text-primary">Mental Health (Arguably the Most Important)</h3>
              </div>
              <div className="space-y-3">
                {[
                  "Focus on the basics first (sleep, movement, and nutrition)",
                  "Spend time in nature regularly and try to get sunlight exposure (especially early in the day)",
                  "Spend time with friends, family, and loved ones. Focus energy on developing meaningful relationships",
                  "Try to reduce stressors in your life (as much as realistically possible)",
                  "Try to make time for hobbies or activities that bring you joy regularly engage in",
                  "Minimize time on electronics, especially social media",
                  "The importance of sleep cannot be understated.",
                  "Try a 5–10 minute daily check-in/reflection/meditation",
                  "Do not write off professional help, therapy, and medications - it takes courage to seek help and sometimes this can be the only way to get better, especially when underlying conditions are present."
                ].map((item, index) => (
                  <div key={index} className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border/50 hover:bg-muted/50 transition-colors">
                    <CheckCircle className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                    <span className="text-base leading-relaxed">{item}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Supplements */}
          <Card className="border-l-4 border-l-primary/60 shadow-premium overflow-hidden bg-gradient-to-br from-background to-muted/20">
            <CardContent className="p-8 sm:p-10">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-2xl">💊</span>
                </div>
                <h3 className="text-2xl sm:text-3xl font-sans font-semibold text-primary">Supplements - After You've Focused on Everything Else</h3>
              </div>
              <p className="text-muted-foreground mb-6 text-lg leading-relaxed">
                Focus on the low hanging fruit with sleep, exercise, nutrition first - supplements are not always necessarily to be "healthy." That said, here are a few with decent support in current literature.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {supplements.map((supp, index) => (
                  <div key={index} className="border border-border/50 rounded-lg p-5 bg-muted/30 hover:bg-muted/50 transition-colors">
                    <div className="mb-2">
                      <span className="font-semibold text-foreground">{supp.name}</span>
                      <span className="text-sm text-muted-foreground ml-2">({supp.dose})</span>
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed">{supp.note}</p>
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
