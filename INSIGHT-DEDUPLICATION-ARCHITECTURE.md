# Insight Deduplication Architecture

**Date:** January 2025  
**Purpose:** Document the current deduplication system for insights extracted from multiple sources  
**Goal:** Enable robust recognition of duplicate insights across hundreds of thousands of entries, even when wording differs slightly

---

## Executive Summary

The current system uses **exact hash-based deduplication** on normalized insight statements. This approach is fast and deterministic but has limitations: it only catches exact duplicates after normalization (lowercase, whitespace collapse). It does **not** currently detect semantic duplicates where the same idea is expressed with different wording.

**Key Infrastructure Already in Place:**
- ✅ Hash-based exact deduplication (current primary method)
- ✅ Embeddings infrastructure (vector embeddings for semantic search)
- ✅ Multi-source tracking (`insight_sources` table)
- ✅ Semantic search RPC function (for similarity queries)

**Gap:**
- ❌ Semantic similarity is not used during ingestion for deduplication
- ❌ No automatic merging of semantically similar insights

---

## Current Deduplication Mechanism

### 1. Hash-Based Deduplication (Primary Method)

**Location:** `lib/pipeline.ts`

**Process:**
1. When an insight is extracted from a chunk, the system computes a SHA256 hash of the normalized statement
2. Normalization process:
   ```typescript
   function normalizeStatement(statement: string): string {
     return statement
       .trim()
       .toLowerCase()
       .replace(/\s+/g, ' ')  // Collapse all whitespace to single spaces
   }
   ```
3. Hash computation:
   ```typescript
   function computeInsightHash(statement: string): string {
     const normalized = normalizeStatement(statement)
     return createHash('sha256').update(normalized).digest('hex')
   }
   ```

**Deduplication Logic:**
```typescript
// In processSourceFromPlainText() at line 1216-1232
const insightHash = computeInsightHash(insight.statement)

// Check if insight with this hash already exists
const { data: existingInsight } = await supabaseAdmin
  .from('insights')
  .select('id')
  .eq('insight_hash', insightHash)
  .single()

if (existingInsight) {
  // Insight already exists - reuse existing ID
  insightId = existingInsight.id
} else {
  // Insert new insight
  // ... create new insight record
}
```

**What This Catches:**
- ✅ Exact duplicates (same text)
- ✅ Case-insensitive duplicates ("Testosterone affects behavior" = "testosterone affects behavior")
- ✅ Whitespace-normalized duplicates ("word1  word2" = "word1 word2")
- ✅ Leading/trailing whitespace differences

**What This Misses:**
- ❌ Paraphrased duplicates ("Testosterone influences behavior" vs "Testosterone affects behavior")
- ❌ Synonym-based duplicates ("Testosterone impacts behavior" vs "Testosterone affects behavior")
- ❌ Structurally different but semantically identical statements
- ❌ Statements with minor wording differences that convey the same meaning

### 2. Database Schema

**Insights Table:**
```sql
CREATE TABLE insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement text NOT NULL,                    -- The actual insight text
  context_note text,                           -- Additional context
  evidence_type text CHECK (...) NOT NULL,    -- RCT, Cohort, MetaAnalysis, etc.
  qualifiers jsonb,                           -- Population, dose, duration, etc.
  confidence text CHECK (...) NOT NULL,       -- high, medium, low
  insight_hash text NOT NULL,                 -- SHA256 hash for exact deduplication
  importance int CHECK (importance IN (1, 2, 3)),
  actionability text CHECK (...) DEFAULT 'Medium',
  primary_audience text CHECK (...) DEFAULT 'Both',
  insight_type text CHECK (...) DEFAULT 'Explanation',
  embedding vector(1536),                     -- Vector embedding for semantic search
  deleted_at timestamptz,                    -- Soft delete
  created_at timestamptz DEFAULT now()
);

-- Index for fast hash lookups
CREATE INDEX insights_hash_idx ON insights (insight_hash);
```

**Insight Sources Table (Multi-Source Tracking):**
```sql
CREATE TABLE insight_sources (
  insight_id uuid REFERENCES insights(id) ON DELETE CASCADE,
  source_id uuid REFERENCES sources(id) ON DELETE CASCADE,
  locator text,                               -- Which chunk (e.g., "seg-001")
  start_ms integer,                           -- Optional: timestamp in source
  end_ms integer,                             -- Optional: timestamp in source
  run_id uuid,                                -- Which processing run
  PRIMARY KEY (insight_id, source_id, locator)
);

-- Indexes for efficient queries
CREATE INDEX insight_sources_insight_idx ON insight_sources (insight_id);
CREATE INDEX insight_sources_source_idx ON insight_sources (source_id);
```

**Key Design Feature:**
The `insight_sources` table uses a composite primary key `(insight_id, source_id, locator)`, which means:
- ✅ The same insight can be linked to multiple sources
- ✅ The same insight can appear multiple times in the same source (different chunks)
- ✅ When a duplicate is found (by hash), the system links the new source to the existing insight

**Example:**
```
Insight: "Testosterone levels peak in the morning"
- Hash: abc123...
- Sources:
  - Source A, chunk seg-001
  - Source B, chunk seg-045
  - Source C, chunk seg-012
```

### 3. Embeddings Infrastructure (Available but Not Used for Deduplication)

**Embedding Generation:**
- Location: `lib/embeddings.ts`
- Model: OpenAI `text-embedding-3-small` (1536 dimensions)
- Generated asynchronously during pipeline processing (non-blocking)
- Embedding combines: `statement + context_note` (if present)

**Storage:**
```sql
ALTER TABLE insights
  ADD COLUMN embedding vector(1536);

-- IVFFlat index for fast similarity search
CREATE INDEX insights_embedding_idx ON insights 
  USING ivfflat (embedding vector_cosine_ops) 
  WITH (lists = 100)
  WHERE embedding IS NOT NULL;
```

**Semantic Search Function:**
```sql
CREATE OR REPLACE FUNCTION search_insights_semantic(
  query_embedding vector(1536),
  concept_id uuid DEFAULT NULL,
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  statement text,
  similarity float,
  ...
)
```

**Current Usage:**
- ✅ Used for semantic search queries (finding similar insights)
- ✅ Used for concept discovery and connections
- ❌ **NOT used during ingestion for deduplication**

---

## Data Flow: Insight Extraction and Deduplication

### Pipeline Flow (`lib/pipeline.ts::processSourceFromPlainText()`)

```
1. Source Text Input
   ↓
2. Chunking
   - Split by paragraphs (double newlines)
   - Target size: ~2400 chars per chunk
   - Overlap: 200 chars between chunks
   - Creates chunks with locators (seg-001, seg-002, ...)
   ↓
3. For Each Chunk:
   ↓
   3a. OpenAI Extraction
       - Model: gpt-5-mini
       - Extracts structured insights (statement, evidence_type, confidence, etc.)
       - Filters low-value insights (regex patterns, length checks)
       ↓
   3b. For Each Extracted Insight:
       ↓
       3b.1. Compute Hash
            - Normalize statement (lowercase, whitespace collapse)
            - SHA256 hash
            ↓
       3b.2. Check for Existing Insight
            - Query: SELECT id FROM insights WHERE insight_hash = ?
            - Uses indexed lookup (fast)
            ↓
       3b.3a. If Found (Duplicate):
             - Reuse existing insight_id
             - Link new source to existing insight
             - INSERT INTO insight_sources (insight_id, source_id, locator)
             - Log: "Found existing insight with hash..."
             ↓
       3b.3b. If Not Found (New):
             - INSERT INTO insights (statement, hash, ...)
             - Get new insight_id
             - Link source to new insight
             - INSERT INTO insight_sources (insight_id, source_id, locator)
             - Generate embedding (async, fire-and-forget)
             - Mark needs_tagging = true (for async concept tagging)
             ↓
   3c. Continue to Next Chunk
   ↓
4. Processing Complete
   - Update source_processing_runs record
   - Log statistics (chunks processed, insights created, etc.)
```

### Example: Duplicate Detection Scenario

**Scenario:** Two sources contain the same insight with identical wording

**Source A, Chunk seg-005:**
```
"Testosterone levels are highest in the morning, typically between 6-8 AM."
```

**Source B, Chunk seg-012:**
```
"Testosterone levels are highest in the morning, typically between 6-8 AM."
```

**Processing:**
1. Source A processed first:
   - Hash computed: `def456...`
   - No existing insight found
   - New insight created with ID `insight-001`
   - `insight_sources`: `(insight-001, source-A, seg-005)`

2. Source B processed later:
   - Hash computed: `def456...` (same hash)
   - Existing insight found: `insight-001`
   - No new insight created
   - `insight_sources`: `(insight-001, source-A, seg-005)`, `(insight-001, source-B, seg-012)`

**Result:**
- ✅ One insight record in database
- ✅ Two source links (shows insight appears in both sources)
- ✅ Querying `insight_sources` shows both sources

---

## Current Limitations and Gaps

### 1. Semantic Duplicates Not Detected

**Problem:**
The hash-based approach only catches exact duplicates after normalization. It does not detect semantically identical insights with different wording.

**Example of Missed Duplicate:**
```
Insight 1: "Testosterone levels peak during early morning hours, around 6-8 AM."
Insight 2: "Testosterone concentrations are highest in the morning, typically between 6 and 8 AM."
```

These are semantically identical but have different hashes:
- Hash 1: `abc123...`
- Hash 2: `xyz789...`
- Result: Two separate insight records created

**Impact:**
- As the database grows to hundreds of thousands of insights, semantic duplicates will accumulate
- Users will see multiple "versions" of the same insight
- Source tracking becomes fragmented across duplicate insights

### 2. No Semantic Similarity Check During Ingestion

**Current State:**
- Embeddings are generated for all insights
- Semantic search function exists and works
- But semantic similarity is **not checked** during the ingestion pipeline

**What Would Be Needed:**
1. When a new insight is extracted:
   - Generate embedding (already done)
   - Query existing insights for semantic similarity
   - If similarity > threshold (e.g., 0.85), treat as duplicate
   - Link source to existing insight instead of creating new one

2. Performance Considerations:
   - Vector similarity search is fast with IVFFlat index
   - But checking every new insight against all existing insights could be slow at scale
   - Would need batching or approximate nearest neighbor search

### 3. No Automatic Merging of Semantic Duplicates

**Current State:**
- If two semantically similar insights are created, they remain separate
- No process to merge them later
- No way to consolidate sources across semantic duplicates

**What Would Be Needed:**
- Background job to find semantic duplicates
- Merge process that:
  - Selects "canonical" insight (e.g., most recent, or highest confidence)
  - Merges source links from duplicate insights
  - Updates concept tags
  - Soft-deletes or merges duplicate records

---

## Infrastructure Ready for Enhancement

### 1. Embeddings Already Generated

**Current Implementation:**
```typescript
// In pipeline.ts, after creating new insight:
(async () => {
  try {
    const embedding = await generateInsightEmbedding(insight)
    await supabaseAdmin
      .from('insights')
      .update({ embedding })
      .eq('id', insightId)
  } catch (error) {
    // Log but don't fail
  }
})()
```

**Status:** ✅ Embeddings are generated asynchronously for all new insights

### 2. Semantic Search Function Exists

**Function:** `search_insights_semantic()`
- Takes query embedding
- Returns similar insights with similarity scores
- Uses cosine similarity (1 - distance)
- Threshold-based filtering (default 0.7)

**Status:** ✅ Ready to use, but not called during ingestion

### 3. Multi-Source Tracking Works

**Current Behavior:**
- When duplicate found (by hash), source is linked to existing insight
- `insight_sources` table tracks all sources for each insight
- Querying sources shows all places where insight appears

**Status:** ✅ Works correctly for hash-based duplicates

---

## Recommended Enhancements

### Phase 1: Semantic Deduplication During Ingestion

**Approach:**
1. After computing hash and checking for exact duplicate:
   - If no exact duplicate found, generate embedding
   - Query semantic search for similar insights (threshold: 0.85-0.90)
   - If similar insight found:
     - Link source to existing insight (don't create new)
     - Optionally: log semantic duplicate detection
   - If no similar insight found:
     - Create new insight as normal

**Implementation Considerations:**
- Performance: Use approximate nearest neighbor search (IVFFlat index)
- Threshold: Start with 0.85 (high similarity) to avoid false positives
- Batch processing: Could batch embedding generation and similarity checks

**Code Location:**
- Modify `lib/pipeline.ts::processSourceFromPlainText()` around line 1216-1306
- Add semantic similarity check after hash lookup fails

### Phase 2: Background Deduplication Job

**Approach:**
1. Periodic job (e.g., daily) to find semantic duplicates
2. For each insight without exact hash match:
   - Find semantically similar insights (similarity > 0.80)
   - Group into duplicate clusters
   - Select canonical insight (highest confidence, most sources, or most recent)
   - Merge source links from duplicates into canonical
   - Soft-delete or archive duplicates

**Implementation Considerations:**
- Use batch processing to avoid overwhelming database
- Track merge history for audit trail
- Update concept tags from merged insights

### Phase 3: Hybrid Deduplication Strategy

**Approach:**
1. **Fast Path (Hash):** Check exact hash first (current, very fast)
2. **Medium Path (Semantic):** If no exact match, check semantic similarity (threshold 0.90)
3. **Slow Path (Deep Analysis):** For high-value insights, use LLM to determine if truly duplicate

**Benefits:**
- Hash catches most duplicates instantly
- Semantic catches paraphrased duplicates
- Deep analysis handles edge cases

---

## Database Query Patterns

### Finding All Sources for an Insight

```sql
SELECT 
  i.id,
  i.statement,
  COUNT(DISTINCT is.source_id) as source_count,
  array_agg(DISTINCT s.title) as source_titles
FROM insights i
JOIN insight_sources is ON i.id = is.insight_id
JOIN sources s ON is.source_id = s.id
WHERE i.id = 'insight-uuid'
GROUP BY i.id, i.statement;
```

### Finding Duplicate Insights (Hash-Based)

```sql
SELECT 
  insight_hash,
  COUNT(*) as duplicate_count,
  array_agg(id) as insight_ids,
  array_agg(statement) as statements
FROM insights
WHERE deleted_at IS NULL
GROUP BY insight_hash
HAVING COUNT(*) > 1;
```

### Finding Semantically Similar Insights

```sql
-- Using the semantic search function
SELECT * FROM search_insights_semantic(
  query_embedding := (SELECT embedding FROM insights WHERE id = 'insight-uuid'),
  match_threshold := 0.85,
  match_count := 10
);
```

### Insights with Multiple Sources

```sql
SELECT 
  i.id,
  i.statement,
  COUNT(DISTINCT is.source_id) as source_count
FROM insights i
JOIN insight_sources is ON i.id = is.insight_id
WHERE i.deleted_at IS NULL
GROUP BY i.id, i.statement
HAVING COUNT(DISTINCT is.source_id) > 1
ORDER BY source_count DESC;
```

---

## Performance Characteristics

### Hash-Based Lookup
- **Speed:** O(1) with indexed hash column
- **Scalability:** Excellent (millions of insights)
- **Accuracy:** 100% for exact duplicates
- **False Positives:** 0%
- **False Negatives:** High (misses semantic duplicates)

### Semantic Similarity Search
- **Speed:** O(log n) with IVFFlat index (approximate)
- **Scalability:** Good (hundreds of thousands of insights)
- **Accuracy:** Depends on threshold (0.85-0.90 recommended)
- **False Positives:** Low with high threshold
- **False Negatives:** Some edge cases

### Current Pipeline Performance
- **Chunking:** Fast (in-memory string operations)
- **OpenAI Extraction:** ~2-5 seconds per chunk (API call)
- **Hash Lookup:** <1ms per insight (indexed)
- **Embedding Generation:** ~200-500ms per insight (async, non-blocking)
- **Source Linking:** <1ms per link (indexed)

**Bottleneck:** OpenAI extraction (sequential processing of chunks)

---

## Schema Evolution History

### Initial Schema (Base)
- `insights` table with basic fields
- `insight_hash` for deduplication
- `insight_sources` for multi-source tracking

### Migration 001: Enhanced Metadata
- Added: `importance`, `actionability`, `primary_audience`, `insight_type`, `tone`
- Purpose: Richer insight classification

### Migration 015: Embeddings
- Added: `embedding vector(1536)` column
- Added: IVFFlat index for similarity search
- Purpose: Enable semantic search

### Current State
- Hash-based deduplication: ✅ Working
- Embeddings: ✅ Generated for all insights
- Semantic search: ✅ Available via RPC function
- Semantic deduplication: ❌ Not implemented

---

## Testing and Validation

### Current Test Scenarios

**1. Exact Duplicate Detection:**
- ✅ Same text, different case → Detected
- ✅ Same text, different whitespace → Detected
- ✅ Same text, different source → Source linked correctly

**2. Semantic Duplicate Detection:**
- ❌ Paraphrased statements → Not detected (creates duplicates)
- ❌ Synonym-based differences → Not detected
- ❌ Structurally different but same meaning → Not detected

### Recommended Test Cases

**1. Hash-Based:**
- Test normalization (case, whitespace)
- Test hash collision (extremely rare, but verify)
- Test multi-source linking

**2. Semantic:**
- Test threshold sensitivity (0.80, 0.85, 0.90)
- Test false positives (different but similar insights)
- Test false negatives (same meaning, different words)
- Test edge cases (very short insights, very long insights)

---

## Next Steps for Team Evaluation

### Questions to Consider

1. **Threshold Selection:**
   - What similarity threshold should be used? (0.85, 0.90, 0.95?)
   - How to balance false positives vs false negatives?

2. **Performance Requirements:**
   - Acceptable latency for semantic check during ingestion?
   - Should semantic check be synchronous or async?

3. **Merge Strategy:**
   - How to select canonical insight when merging duplicates?
   - What to do with conflicting metadata (confidence, evidence_type)?

4. **User Experience:**
   - How to display "multiple sources" for an insight?
   - Should users see all source links or just count?

5. **Scale Considerations:**
   - At what point does semantic checking become too slow?
   - Should we use approximate nearest neighbor (ANN) search?

### Recommended Evaluation Areas

1. **Review Current Hash-Based System:**
   - Verify it's working correctly
   - Check for any hash collisions
   - Validate multi-source tracking

2. **Evaluate Semantic Search Infrastructure:**
   - Test semantic search function performance
   - Verify embedding quality
   - Check index performance at scale

3. **Design Semantic Deduplication:**
   - Choose similarity threshold
   - Design merge/consolidation strategy
   - Plan for edge cases

4. **Performance Testing:**
   - Benchmark semantic search at current scale
   - Project performance at 100k+ insights
   - Test batch processing approaches

---

## Conclusion

The current system has a solid foundation:
- ✅ Fast, reliable hash-based deduplication
- ✅ Multi-source tracking infrastructure
- ✅ Embeddings and semantic search capabilities

The main gap is **semantic deduplication during ingestion**. The infrastructure exists, but it's not currently used to prevent duplicate insights with different wording.

**Recommended Path Forward:**
1. Evaluate current system (this document)
2. Design semantic deduplication approach
3. Implement Phase 1 (semantic check during ingestion)
4. Monitor and tune threshold
5. Add Phase 2 (background deduplication job) if needed

This architecture document provides the foundation for making informed decisions about enhancing the deduplication system to handle semantic duplicates at scale.
