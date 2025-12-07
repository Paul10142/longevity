-- Migration: Mark lever concepts and add lever metadata
-- Updates the 5 core lever concepts with lever-specific data

-- Update Sleep & Circadian Health
UPDATE concepts
SET 
  is_lever = true,
  lever_order = 1,
  lever_metadata = jsonb_build_object(
    'tagline', 'The foundation for everything else',
    'primaryBenefits', jsonb_build_array(
      'Improved cognitive function and mental clarity',
      'Enhanced energy levels throughout the day',
      'Better mood regulation and emotional resilience',
      'Support for physical recovery and immune function',
      'Foundation for sustainable behavior change'
    )
  )
WHERE slug = 'sleep-circadian';

-- Update Exercise & Training
UPDATE concepts
SET 
  is_lever = true,
  lever_order = 2,
  lever_metadata = jsonb_build_object(
    'tagline', 'Strength, endurance, and stability for longevity',
    'primaryBenefits', jsonb_build_array(
      'Dramatically reduced all-cause mortality risk',
      'Improved cardiovascular health and metabolic function',
      'Enhanced strength and functional capacity',
      'Better mental health and cognitive function',
      'Increased energy and vitality'
    )
  )
WHERE slug = 'exercise-training';

-- Update Nutrition & Diet
UPDATE concepts
SET 
  is_lever = true,
  lever_order = 3,
  lever_metadata = jsonb_build_object(
    'tagline', 'Simple, filling, and sustainable',
    'primaryBenefits', jsonb_build_array(
      'Improved metabolic health and insulin sensitivity',
      'Better energy levels and reduced inflammation',
      'Support for cognitive function and mental clarity',
      'Enhanced physical performance and recovery',
      'Sustainable weight management'
    )
  )
WHERE slug = 'nutrition-diet';

-- Update Emotional & Mental Health
UPDATE concepts
SET 
  is_lever = true,
  lever_order = 4,
  lever_metadata = jsonb_build_object(
    'tagline', 'Arguably the most important lever',
    'primaryBenefits', jsonb_build_array(
      'Improved quality of life and life satisfaction',
      'Better stress management and emotional regulation',
      'Enhanced relationships and social connection',
      'Increased resilience and ability to cope with challenges',
      'Foundation for sustainable behavior change'
    )
  )
WHERE slug = 'emotional-mental-health';

-- Update Supplements & Adjuncts
UPDATE concepts
SET 
  is_lever = true,
  lever_order = 5,
  lever_metadata = jsonb_build_object(
    'tagline', 'After you''ve focused on everything else',
    'primaryBenefits', jsonb_build_array(
      'Targeted support for specific deficiencies or needs',
      'Evidence-based supplementation when appropriate',
      'Complement to lifestyle changes (not a replacement)',
      'Support for specific health goals when basics are covered',
      'Understanding when medical interventions are necessary'
    )
  )
WHERE slug = 'supplements-adjuncts';

