-- Migration: Add deduplication model tracking tables
-- Supports fine-tuning workflow and model versioning

-- Track fine-tuned models
CREATE TABLE IF NOT EXISTS deduplication_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id text NOT NULL, -- OpenAI fine-tuned model ID (e.g., "ft:gpt-4o-mini-2024-...")
  version int NOT NULL,
  training_data_count int NOT NULL,
  positive_examples int,
  negative_examples int,
  accuracy_metrics jsonb, -- { accuracy, precision, recall, f1_score, test_set_size }
  created_at timestamptz DEFAULT now(),
  is_active boolean DEFAULT false,
  notes text,
  UNIQUE(model_id)
);

CREATE INDEX IF NOT EXISTS deduplication_models_active_idx ON deduplication_models (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS deduplication_models_version_idx ON deduplication_models (version DESC);

-- Track training data exports
CREATE TABLE IF NOT EXISTS training_data_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_date timestamptz DEFAULT now(),
  positive_examples int NOT NULL,
  negative_examples int NOT NULL,
  total_examples int NOT NULL,
  format text CHECK (format IN ('openai_jsonl', 'custom_json')) NOT NULL,
  file_path text,
  model_version int REFERENCES deduplication_models(version),
  exported_by text,
  notes text
);

CREATE INDEX IF NOT EXISTS training_data_exports_date_idx ON training_data_exports (export_date DESC);

-- Track model predictions (for evaluation and continuous learning)
CREATE TABLE IF NOT EXISTS model_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid REFERENCES deduplication_models(id),
  insight1_id uuid REFERENCES insights(id) ON DELETE CASCADE,
  insight2_id uuid REFERENCES insights(id) ON DELETE CASCADE,
  prediction text CHECK (prediction IN ('MERGE', 'DON\'T_MERGE')) NOT NULL,
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  similarity_score numeric, -- Embedding similarity score
  actual_label text CHECK (actual_label IN ('MERGE', 'DON\'T_MERGE')), -- From manual decision (if available)
  is_correct boolean, -- Computed: prediction === actual_label
  created_at timestamptz DEFAULT now(),
  reviewed_at timestamptz, -- When manual review happened
  reviewed_by text
);

CREATE INDEX IF NOT EXISTS model_predictions_model_idx ON model_predictions (model_id);
CREATE INDEX IF NOT EXISTS model_predictions_insight1_idx ON model_predictions (insight1_id);
CREATE INDEX IF NOT EXISTS model_predictions_insight2_idx ON model_predictions (insight2_id);
CREATE INDEX IF NOT EXISTS model_predictions_actual_label_idx ON model_predictions (actual_label) WHERE actual_label IS NOT NULL;
CREATE INDEX IF NOT EXISTS model_predictions_created_at_idx ON model_predictions (created_at DESC);

-- Add comments
COMMENT ON TABLE deduplication_models IS 'Fine-tuned models for automatic deduplication';
COMMENT ON TABLE training_data_exports IS 'Exports of training data used for fine-tuning';
COMMENT ON TABLE model_predictions IS 'Model predictions for evaluation and continuous learning';
