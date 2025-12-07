# Scalability Analysis: Protocols, Patient View, Clinician View

**Date:** January 2025  
**Context:** Assessment of architecture scalability from 3 sources to 300+ sources

---

## Executive Summary

The current architecture has **solid foundations** but will face **significant bottlenecks** at scale. The system is well-designed for the current 3-source setup, but several critical areas need attention before scaling to 300+ sources.

**Key Findings:**
- ✅ **Database schema** is well-structured with proper indexes
- ✅ **Deduplication** via hash-based matching scales well
- ⚠️ **Topic pages** load ALL insights at once (no pagination)
- ⚠️ **Protocol/article generation** processes ALL insights for a concept (could be 1000s)
- ⚠️ **Concepts are flat** - no hierarchy/taxonomy implemented
- ⚠️ **No semantic search** - only basic keyword filtering
- ⚠️ **Auto-tagging** will become expensive at scale

---

## Current Architecture Overview

### Data Flow

```
Sources (300+) 
  → Chunks (segmented transcripts)
    → Insights (deduplicated, canonical statements)
      → Insight-Concepts (many-to-many tagging)
        → Topic Pages (Protocol + Patient Article + Clinician Article + Evidence)
```

### Key Tables

- **`sources`**: 300+ sources (scales linearly)
- **`insights`**: ~10-50 per source = **3,000-15,000 total insights** (with deduplication)
- **`concepts`**: Currently ~11 concepts (flat structure)
- **`insight_concepts`**: Many-to-many links (scales well with indexes)
- **`topic_articles`**: One per concept per audience (versioned)
- **`topic_protocols`**: One per concept (versioned)

---

## Scalability Assessment by Component

### 1. Protocols (`topic_protocols`)

**Current Implementation:**
- Stored in `topic_protocols` table with versioning
- Generated from **ALL insights** linked to a concept
- No limit on insight count in generation

**Scalability Issues:**

#### ❌ **Critical: Protocol Generation Bottleneck**

```typescript
// lib/topicProtocols.ts:191-212
// Loads ALL insights for a concept
const { data: insightsData } = await supabaseAdmin
  .from("insight_concepts")
  .select("insights (*)")
  .eq("concept_id", conceptId)
  .is("insights.deleted_at", null)

// Sends ALL insights to OpenAI in one request
const insightsJson = JSON.stringify(insights, null, 2)
```

**Problem at Scale:**
- A popular concept (e.g., "Metabolic Health") could have **500-2000+ insights** from 300 sources
- OpenAI token limits: GPT-4o has ~128k context window
- At ~500 insights × ~500 tokens each = **250k tokens** (exceeds limit)
- Even if within limits, generation becomes **slow and expensive**

**Impact:**
- Protocol generation will **fail or timeout** for large concepts
- Cost per protocol generation increases linearly with insight count
- No way to prioritize which insights to include

#### ⚠️ **Moderate: Protocol Storage**

- Storage scales fine (one protocol per concept, versioned)
- No pagination needed (protocols are single documents)

**Recommendations:**
1. **Implement insight prioritization** for protocol generation:
   - Filter by `importance` (3 = highest)
   - Filter by `actionability` (High/Medium only)
   - Filter by `evidence_type` (prioritize RCT, MetaAnalysis)
   - Limit to top 200-300 most relevant insights
2. **Add pagination/streaming** for very large insight sets
3. **Cache protocol generation** results (regenerate only when new high-importance insights added)

---

### 2. Patient View (`topic_articles` with `audience='patient'`)

**Current Implementation:**
- Stored in `topic_articles` table, versioned
- Generated from **ALL insights** linked to a concept
- Same generation logic as clinician view

**Scalability Issues:**

#### ❌ **Critical: Same Generation Bottleneck as Protocols**

```typescript
// lib/topicNarrative.ts:191-212
// Loads ALL insights for a concept
const { data: insightsData } = await supabaseAdmin
  .from("insight_concepts")
  .select("insights (*)")
  .eq("concept_id", conceptId)
  .is("insights.deleted_at", null)
```

**Problem at Scale:**
- Same token limit issues as protocols
- Patient articles may need to be **shorter/more focused** than clinician articles
- No filtering by `primary_audience` field during generation

**Impact:**
- Article generation fails for large concepts
- Articles become too long/dense for patient consumption
- Higher costs per article generation

**Recommendations:**
1. **Filter insights by `primary_audience`** during generation:
   - Include: `primary_audience IN ('Patient', 'Both')`
2. **Implement same prioritization** as protocols
3. **Consider article length limits** (e.g., max 300 insights)
4. **Generate summary + detailed sections** for very large topics

---

### 3. Clinician View (`topic_articles` with `audience='clinician'`)

**Current Implementation:**
- Same as patient view, different prompt
- More technical, comprehensive

**Scalability Issues:**

#### ❌ **Critical: Same Generation Bottleneck**

- Clinician articles are meant to be **comprehensive**, but still hit token limits
- No filtering by `primary_audience` during generation

**Recommendations:**
1. **Filter by `primary_audience IN ('Clinician', 'Both')`**
2. **Allow longer articles** than patient view (but still cap at ~500 insights)
3. **Implement section-based generation** for very large topics:
   - Generate overview from top 100 insights
   - Generate detailed sections from remaining insights
   - Combine into single article

---

### 4. Evidence View (Topic Page)

**Current Implementation:**
```typescript
// app/topics/[slug]/page.tsx:122-154
// Loads ALL insights for a concept
const result = await supabaseAdmin
  .from("insight_concepts")
  .select("insights (*)")
  .eq("concept_id", concept.id)
  .is("insights.deleted_at", null)
```

**Scalability Issues:**

#### ❌ **Critical: No Pagination**

**Problem at Scale:**
- Topic pages load **ALL insights** at once
- A popular concept could have **1000+ insights**
- Browser renders all insights in DOM (performance issue)
- Initial page load becomes **slow** (5-10+ seconds)
- Memory usage high for large pages

**Current State:**
- Admin review page (`/admin/insights/review`) **HAS pagination** (100 per page)
- Topic pages (`/topics/[slug]`) **NO pagination**

**Impact:**
- Page load times increase linearly with insight count
- Browser crashes on very large pages
- Poor user experience

**Recommendations:**
1. **Implement pagination** for evidence view:
   - Default: Show top 50 insights (sorted by importance)
   - "Load More" button or infinite scroll
   - Pagination controls (50/100/200 per page)
2. **Virtual scrolling** for very large lists
3. **Server-side filtering** by importance/actionability
4. **Lazy loading** of source metadata

---

## Categorization & Taxonomy

### Current State

**Concepts Table:**
- Flat structure (no hierarchy)
- ~11 concepts seeded
- `concept_parents` table exists but **unused**

**Auto-Tagging:**
- AI-based tagging to concepts
- Filters to top 15 most relevant concepts (keyword matching)
- Processes insights in batches of 8

**Issues at Scale:**

#### ❌ **Critical: Flat Concept Structure**

**Problem:**
- With 300 sources, you'll need **50-100+ concepts** to organize insights
- Flat list becomes **unmanageable**
- No way to browse by category (e.g., "Cardiovascular" → "Blood Pressure" → "Hypertension")
- Concepts will overlap and become ambiguous

**Example Problem:**
- "Metabolic Health" (broad)
- "Insulin Sensitivity" (specific)
- "Glucose Regulation" (specific)
- "Diabetes Management" (overlaps with above)

Without hierarchy, these become a flat, confusing list.

#### ⚠️ **Moderate: Auto-Tagging Performance**

**Current:**
```typescript
// lib/autotag.ts:55-87
// Filters to top 15 concepts using keyword matching
function filterRelevantConcepts(insight: Insight, concepts: Concept[], topN: number = 15)
```

**Problem at Scale:**
- With 100 concepts, filtering to top 15 becomes less effective
- Keyword matching is **basic** (no semantic understanding)
- Still processes all concepts for scoring (O(n) where n = concept count)

**Impact:**
- Auto-tagging becomes less accurate
- More manual tagging required
- Slower processing (though still acceptable)

**Recommendations:**
1. **Implement concept hierarchy:**
   ```sql
   -- Use existing concept_parents table
   -- Example structure:
   -- Cardiovascular Health (parent)
   --   → Blood Pressure (child)
   --     → Hypertension (grandchild)
   --   → Cholesterol (child)
   ```
2. **Add concept browsing UI:**
   - Tree view for concepts
   - Filter topics by parent category
   - Breadcrumb navigation
3. **Improve auto-tagging:**
   - Use embeddings for semantic matching (pgvector already enabled)
   - Filter by parent concept first, then children
   - Cache concept embeddings

---

## Search & Discovery

### Current State

**Search Capabilities:**
- Basic text search in admin review page (`statement.ilike`, `context_note.ilike`)
- Filter by source, topic, evidence type, confidence, etc.
- **No semantic search**
- **No full-text search indexes**

**Issues at Scale:**

#### ❌ **Critical: No Semantic Search**

**Problem:**
- With 15,000 insights, keyword search becomes **ineffective**
- Users can't find insights by meaning (e.g., "ways to improve sleep quality")
- Must know exact keywords

**Example:**
- Search: "sleep" → finds insights with word "sleep"
- Misses: "circadian rhythm", "melatonin", "REM cycles" (related but different keywords)

#### ⚠️ **Moderate: No Full-Text Search**

- PostgreSQL full-text search not implemented
- `pgvector` extension enabled but **not used** for search
- Chunks table has `embedding vector(1536)` column but **empty**

**Recommendations:**
1. **Implement semantic search:**
   - Generate embeddings for insights (use OpenAI embeddings API)
   - Store in `chunks.embedding` or new `insights.embedding` column
   - Use pgvector for similarity search
   - Add search UI to topic pages
2. **Add full-text search:**
   - PostgreSQL `tsvector` for keyword search
   - Combine with semantic search for hybrid results
3. **Add faceted search:**
   - Filter by multiple concepts simultaneously
   - Filter by evidence type, confidence, date range
   - Combine with search query

---

## Database Performance

### Current Indexes

**Good:**
- `insights_hash_idx` - Fast deduplication ✅
- `insight_concepts_concept_idx` - Fast concept lookups ✅
- `insights_created_at_idx` - Fast sorting ✅
- `insights_deleted_at_idx` - Fast filtering ✅

**Missing:**
- No index on `insights.importance` (used for sorting)
- No index on `insights.actionability` (used for filtering)
- No full-text search index on `insights.statement`

**Recommendations:**
1. **Add missing indexes:**
   ```sql
   CREATE INDEX insights_importance_idx ON insights (importance DESC NULLS LAST);
   CREATE INDEX insights_actionability_idx ON insights (actionability);
   CREATE INDEX insights_statement_fts_idx ON insights USING gin(to_tsvector('english', statement));
   ```
2. **Monitor query performance** as data grows
3. **Consider materialized views** for common aggregations

---

## Cost Analysis (OpenAI API)

### Current Costs

**Protocol Generation:**
- ~500 insights × ~500 tokens = 250k tokens input
- ~10k tokens output
- Cost: ~$0.50-1.00 per protocol (GPT-4o)

**Article Generation:**
- Same as protocol
- Cost: ~$0.50-1.00 per article × 2 audiences = **$1.00-2.00 per topic**

**Auto-Tagging:**
- 8 insights per batch × ~200 tokens = 1.6k tokens
- Cost: ~$0.001 per batch (GPT-5-mini)
- For 15,000 insights: ~1,875 batches = **$1.88**

**At 300 Sources:**
- 15,000 insights
- 50-100 concepts
- Regenerate all protocols/articles: **$50-200**
- Auto-tag all insights: **$1.88**

**Recommendations:**
1. **Cache protocol/article generation** (only regenerate when high-importance insights added)
2. **Prioritize insights** before generation (reduce token usage)
3. **Use GPT-5-mini** for article generation where possible (lower cost)

---

## Recommendations Summary

### Immediate (Before 300 Sources)

1. **Add pagination to topic pages** (evidence view)
2. **Implement insight prioritization** for protocol/article generation
3. **Filter by `primary_audience`** during article generation
4. **Add missing database indexes**

### Short-term (50-100 Sources)

1. **Implement concept hierarchy** (use `concept_parents` table)
2. **Add semantic search** (pgvector embeddings)
3. **Implement full-text search** (PostgreSQL tsvector)
4. **Add caching** for protocol/article generation

### Medium-term (100-300 Sources)

1. **Section-based article generation** for very large topics
2. **Advanced filtering UI** (faceted search)
3. **Materialized views** for common queries
4. **Background job processing** for protocol/article generation

### Long-term (300+ Sources)

1. **Microservices architecture** (separate processing service)
2. **Read replicas** for database
3. **CDN caching** for topic pages
4. **Real-time updates** via WebSockets

---

## Risk Assessment

### High Risk (Will Break at Scale)

1. **Protocol/article generation** - Token limits, timeouts
2. **Topic page loading** - No pagination, slow renders
3. **Flat concept structure** - Becomes unmanageable

### Medium Risk (Performance Degradation)

1. **Auto-tagging accuracy** - Less effective with 100+ concepts
2. **Search functionality** - Keyword search insufficient
3. **Database queries** - Some missing indexes

### Low Risk (Scales Well)

1. **Deduplication** - Hash-based matching scales linearly
2. **Database schema** - Well-designed, proper indexes
3. **Storage** - Protocols/articles are small, versioned

---

## Conclusion

The architecture has **strong foundations** but needs **critical improvements** before scaling to 300 sources:

1. **Pagination** is essential for topic pages
2. **Insight prioritization** is essential for protocol/article generation
3. **Concept hierarchy** is essential for organization
4. **Semantic search** is essential for discovery

With these improvements, the system should scale well to 300+ sources. Without them, you'll face performance issues, generation failures, and poor user experience.

**Priority Order:**
1. Pagination (blocks user experience)
2. Insight prioritization (blocks generation)
3. Concept hierarchy (blocks organization)
4. Semantic search (blocks discovery)

