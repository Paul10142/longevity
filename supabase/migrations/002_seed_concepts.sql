-- Seed initial taxonomy concepts
-- Run this in Supabase SQL Editor or via migration tool

INSERT INTO concepts (name, slug, description) VALUES
  ('Metabolic Health', 'metabolic-health', 'Insights related to metabolism, insulin sensitivity, glucose regulation, and metabolic markers'),
  ('Nutrition & Diet', 'nutrition-diet', 'Dietary patterns, macronutrients, micronutrients, meal timing, and nutritional strategies'),
  ('Exercise & Training', 'exercise-training', 'Exercise protocols, training zones, strength training, cardiovascular fitness, and movement patterns'),
  ('Sleep & Circadian Health', 'sleep-circadian', 'Sleep quality, duration, circadian rhythms, chronobiology, and sleep optimization'),
  ('Cardiovascular Health', 'cardiovascular-health', 'Heart health, blood pressure, cholesterol, cardiovascular disease prevention and management'),
  ('Blood Markers & Labs', 'blood-markers-labs', 'Laboratory values, biomarkers, diagnostic tests, and their interpretation'),
  ('Longevity & Aging', 'longevity-aging', 'Aging biology, lifespan extension, healthspan optimization, and age-related disease prevention'),
  ('Neurocognitive Health', 'neurocognitive-health', 'Brain health, cognitive function, neurodegenerative disease prevention, and neuroplasticity'),
  ('Emotional & Mental Health', 'emotional-mental-health', 'Mental wellness, stress management, mood regulation, and psychological health'),
  ('Supplements & Adjuncts', 'supplements-adjuncts', 'Dietary supplements, nutraceuticals, and adjunctive interventions'),
  ('Saunas, Heat & Cold Exposure', 'thermal-exposure', 'Heat therapy, cold therapy, sauna protocols, and thermal stress adaptation')
ON CONFLICT (slug) DO NOTHING;
