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
    <section id="tips" className="py-6 sm:py-8 lg:py-12 bg-primary/5">
      <div className="container">
        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-6 sm:mb-8">Longevity Toolkit</h2>
        <p className="text-lg sm:text-xl text-muted-foreground mb-6 sm:mb-8">
          Evidence-informed, action-first strategies for building sustainable health habits. 
          Start with one habit per domain and track for 14 days.
        </p>

        <div className="space-y-6 sm:space-y-8">
          {/* Big Takeaways - Moved to top */}
          <Card className="border-l-4 border-l-yellow-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">🎯</span>
                <h3 className="text-2xl font-semibold">The Big 5 Ideas You Need to Take Away from the Presentation</h3>
              </div>
              <div className="space-y-3">
                {bigTakeaways.map((takeaway, index) => (
                  <div key={index} className="flex items-start gap-3">
                    <Badge variant="outline" className="mt-0.5">{index + 1}</Badge>
                    <span className="text-base">{takeaway}</span>
                  </div>
                ))}
              </div>
              
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mt-6">
                <p className="text-yellow-700">
                  <strong>Remember -</strong> your doctors, medical professionals, and healthcare system really do want the best for you and are doing the best they can with the system we have. Medical, pharmacologic, and surgical advancements have changed the face of civilization for the better.
                </p>
                <p className="text-yellow-700 mt-3">
                  That doesn't mean we should ignore the importance of lifestyle changes, but also doesn't mean that drugs and traditional medical interventions are "bad" and that "unnatural" remedies aren't still extremely important!
                </p>
              </div>
            </CardContent>
          </Card>

          {/* How to Actually Change */}
          <Card className="border-l-4 border-l-blue-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">🎯</span>
                <h3 className="text-2xl font-semibold">First Steps to Changing Your Behavior and Creating Healthier Habits (Atomic Habits, Summarized)</h3>
              </div>
              <p className="text-muted-foreground mb-4">
                The way to change behavior is to form a small habit that you'll do consistently. Use these tiny levers to make that happen:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {habitTips.map((tip, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <span className="text-base">{tip}</span>
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

              <h4 className="font-semibold mb-3">General Toolkit:</h4>
              <div className="columns-1 sm:columns-2 gap-6 space-y-3">
                {sleepToolkit.map((tip, index) => (
                  <div key={index} className="flex items-start gap-2 break-inside-avoid">
                    <CheckCircle className="h-4 w-4 text-purple-500 mt-0.5 flex-shrink-0" />
                    <span className="text-base">{tip}</span>
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
                  <span className="font-bold text-2xl">{exerciseStats.stat}</span> - {exerciseStats.description}
                </p>
              </div>

              <h4 className="font-semibold mb-3">Weekly "Minimum Viable" Template:</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">Zone 2</Badge>
                    <span className="text-base">{weeklyTemplate.zone2}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">VO₂max</Badge>
                    <span className="text-base">{weeklyTemplate.vo2max}</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">Strength</Badge>
                    <span className="text-base">{weeklyTemplate.strength}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">Stability</Badge>
                    <span className="text-base">{weeklyTemplate.stability}</span>
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
                  Try to minimize hyper-palatable (addictive) and hyper-processed foods, and switch to minimally processed foods you enjoy (and your tastebuds will change after a couple of months!). The goal isn't to create a new fad diet, but to create a pattern of eating you can stick to for the rest of your life.
                </p>
              </div>

              <h4 className="font-semibold mb-3">Daily Anchors:</h4>
              <div className="columns-1 sm:columns-2 gap-6 space-y-3">
                {nutritionAnchors.map((anchor, index) => (
                  <div key={index} className="flex items-start gap-2 break-inside-avoid">
                    <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <span className="text-base">{anchor}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Workout Resources */}
          <Card className="border-l-4 border-l-red-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">📺</span>
                <h3 className="text-2xl font-semibold">Exercise & Workout Resources</h3>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <h4 className="font-semibold mb-3">Workout YouTube Channels</h4>
                  <div className="space-y-2">
                    {workoutChannels.map((channel, index) => (
                      <div key={index} className="flex items-center justify-between p-2 border rounded">
                        <div>
                          <span className="font-medium">{channel.name}</span>
                          <span className="text-base text-muted-foreground ml-2">({channel.type})</span>
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
                          <span className="text-base text-muted-foreground ml-2">({workout.duration})</span>
                        </div>
                        <a href={workout.url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 mt-6">
                <h4 className="font-semibold mb-2">Beginner-Friendly 2-Day Strength Split (Machine-Based):</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <h5 className="font-medium text-base mb-1">Day A:</h5>
                    <p className="text-base text-muted-foreground">Leg press • Seated row • Chest press machine • Leg curl • Plank (30-60 sec)</p>
                  </div>
                  <div>
                    <h5 className="font-medium text-base mb-1">Day B:</h5>
                    <p className="text-base text-muted-foreground">Leg extension • Lat pulldown • Shoulder press machine • Hip abduction • Wall sit (30-60 sec)</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-2">Start with 2 sets of 8-12 reps, focus on form over weight</p>
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
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 text-base">
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

          {/* Mental Health */}
          <Card className="border-l-4 border-l-pink-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">🧠</span>
                <h3 className="text-2xl font-semibold">Mental Health (Arguably the Most Important)</h3>
              </div>
              <div className="space-y-3">
                <p>• Focus on the basics first (sleep, movement, and nutrition)</p>
                <p>• Spend time in nature regularly and try to get sunlight exposure (especially early in the day)</p>
                <p>• Spend time with friends, family, and loved ones. Focus energy on developing meaningful relationships</p>
                <p>• Try to reduce stressors in your life (as much as realistically possible)</p>
                <p>• Try to make time for hobbies or activities that bring you joy regularly engage in</p>
                <p>• Minimize time on electronics, especially social media</p>
                <p>• The importance of sleep cannot be understated.</p>
                <p>• Try a 5–10 minute daily check-in/reflection/meditation</p>
                <p>• Do not write off professional help, therapy, and medications - it takes courage to seek help and sometimes this can be the only way to get better, especially when underlying conditions are present.</p>
              </div>
              </CardContent>
            </Card>

          {/* Supplements */}
          <Card className="border-l-4 border-l-blue-500">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">💊</span>
                <h3 className="text-2xl font-semibold">Supplements - After You've Focused on Everything Else</h3>
              </div>
              <p className="text-muted-foreground mb-4">
                Focus on the low hanging fruit with sleep, exercise, nutrition first - supplements are not always necessarily to be "healthy." That said, here are a few with decent support in current literature.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {supplements.map((supp, index) => (
                  <div key={index} className="border rounded-lg p-3">
                    <div className="mb-1">
                      <span className="font-medium">{supp.name}</span>
                      <span className="text-base text-muted-foreground ml-1">({supp.dose})</span>
                    </div>
                    <p className="text-base text-muted-foreground">{supp.note}</p>
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
