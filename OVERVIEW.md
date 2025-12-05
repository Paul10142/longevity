# Medical Library MVP - Development Overview

## Project Summary

We've successfully migrated the LifestyleAcademy website from **Vite + React Router** to **Next.js 16** (App Router) and built a new **Medical Library** feature (ClancyMedical MVP) that extracts structured insights from medical transcripts using OpenAI.

**Branch:** `Library`  
**Status:** ✅ Core functionality complete, ready for testing and refinement

---

## What Was Built

### 1. Framework Migration
- ✅ Migrated from Vite to **Next.js 16** (latest stable)
- ✅ Converted React Router to Next.js App Router
- ✅ Ported all existing components (Header, Footer, HeroSection, etc.)
- ✅ Maintained existing UI/UX and styling

### 2. Medical Library Feature (ClancyMedical MVP)

A knowledge extraction system that:
- Allows admins to upload transcripts (podcasts, books, videos, articles)
- Automatically chunks transcripts into ~1000-1500 character segments
- Uses OpenAI to extract structured "Insights" (canonical medical statements)
- Deduplicates insights using SHA256 hashing
- Displays insights in a clean, public-facing interface

---

## Tech Stack

- **Framework:** Next.js 16 (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS + shadcn/ui components
- **Database:** Supabase (PostgreSQL + pgvector extension)
- **AI/ML:** OpenAI API (GPT-4o-mini for extraction)
- **Authentication:** Supabase Auth (ready, not yet implemented)

---

## Database Schema

All tables created via Supabase migration:

### Core Tables
- **`sources`** - Podcast episodes, books, videos, articles
  - Fields: type, title, authors[], date, url, transcript_quality, external_id
- **`chunks`** - Segmented transcript content
  - Fields: source_id, locator (e.g., "seg-001"), content, embedding (vector, nullable)
- **`insights`** - Extracted canonical statements
  - Fields: statement, context_note, evidence_type, qualifiers (JSONB), confidence, insight_hash
- **`insight_sources`** - Links insights to sources with locators
- **`concepts`** - For future concept organization
- **`insight_concepts`** - Links insights to concepts (many-to-many)

### Indexes
- Sources: `external_id`
- Chunks: `source_id`
- Insights: `created_at`, `insight_hash`
- All foreign keys properly indexed

---

## File Structure

```
app/
├── layout.tsx                    # Root layout
├── page.tsx                      # Homepage
├── globals.css                   # Global styles
├── medical-library/
│   └── page.tsx                  # Medical Library landing page
├── admin/
│   └── sources/
│       ├── page.tsx              # List all sources
│       └── new/
│           └── page.tsx          # Create new source form
├── sources/
│   └── [id]/
│       └── page.tsx              # Public view of insights per source
├── transcript/
│   └── page.tsx                  # Transcript page (ported)
└── api/
    └── admin/
        └── sources/
            └── route.ts          # POST endpoint for source creation + processing

lib/
├── supabaseClient.ts             # Client-side Supabase (publishable key)
├── supabaseServer.ts             # Server-side Supabase (secret key)
├── pipeline.ts                   # Processing pipeline (chunking, OpenAI, deduplication)
└── utils.ts                      # Utility functions (cn helper)

components/
├── Header.tsx                    # Navigation (includes Medical Library tab)
├── Footer.tsx
├── HeroSection.tsx
├── ExecutiveTips.tsx
├── ResourcesSection.tsx
├── About.tsx
├── ContactSection.tsx
└── ui/                           # shadcn/ui components
    ├── button.tsx
    ├── card.tsx
    ├── input.tsx
    ├── textarea.tsx
    ├── table.tsx
    ├── badge.tsx
    └── ...
```

---

## Key Features

### Admin Interface (`/admin/sources`)
- **List Sources** (`/admin/sources`)
  - Table view of all sources
  - Shows: title, type, authors, date, created date
  - Link to view insights for each source

- **Create Source** (`/admin/sources/new`)
  - Form fields: type (podcast/book/video/article), title, authors, date, URL
  - Large textarea for transcript paste
  - On submit: Creates source → Triggers processing pipeline → Redirects to list

### Public Interface
- **Medical Library** (`/medical-library`)
  - Landing page with links to admin and future features

- **Source Insights** (`/sources/[id]`)
  - Displays source metadata (title, type, authors, date, URL)
  - Lists all extracted insights with:
    - Statement (canonical paraphrase)
    - Context note (if any)
    - Evidence type badge (RCT, Cohort, MetaAnalysis, etc.)
    - Confidence badge (high/medium/low)
    - Locator chip (e.g., "seg-001")
    - Qualifiers (population, dose, duration, outcome, effect_size, caveats)

### Processing Pipeline (`lib/pipeline.ts`)

**Function:** `processSourceFromPlainText(sourceId, text)`

**Steps:**
1. **Chunking:** Splits transcript by double newlines → groups into ~1000-1500 char chunks
2. **Database:** Inserts chunks with locators (seg-001, seg-002, etc.)
3. **OpenAI Extraction:** For each chunk:
   - Sends to GPT-4o-mini with structured prompt
   - Expects JSON response with insights array
   - Each insight includes: statement, context_note, evidence_type, qualifiers, confidence
4. **Deduplication:**
   - Normalizes statement (trim, lowercase, collapse spaces)
   - Computes SHA256 hash
   - Checks `insights` table for existing hash
   - If exists: Links to existing insight
   - If new: Creates new insight + links to source
5. **Linking:** Inserts into `insight_sources` table

---

## API Endpoints

### `POST /api/admin/sources`
**Purpose:** Create a new source and process its transcript

**Request Body:**
```json
{
  "type": "podcast" | "book" | "video" | "article",
  "title": "string",
  "authors": ["string"],
  "date": "YYYY-MM-DD",
  "url": "string (optional)",
  "transcript": "string (full transcript text)"
}
```

**Response:**
```json
{
  "success": true,
  "sourceId": "uuid",
  "message": "Source created and processed successfully"
}
```

**Error Handling:**
- Returns 400 for missing required fields
- Returns 500 if Supabase/OpenAI operations fail
- Logs errors for debugging

---

## Environment Variables

Required in `.env.local`:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://ipxjckdsqgqkwaqhidqp.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_SECRET_KEY=your-secret-key

# OpenAI
OPENAI_API_KEY=your-openai-api-key
```

**Status:** ✅ All keys have been configured and tested

---

## Current Status

### ✅ Completed
- [x] Next.js 16 migration
- [x] Database schema creation
- [x] Admin interface (list + create sources)
- [x] Processing pipeline (chunking, OpenAI extraction, deduplication)
- [x] Public source view page
- [x] Medical Library navigation tab
- [x] Environment variable configuration
- [x] Supabase and OpenAI API access verified

### 🔄 Ready for Testing
- [ ] End-to-end flow test (create source → view insights)
- [ ] OpenAI prompt refinement (based on actual transcript results)
- [ ] Error handling UI improvements
- [ ] Loading states during processing

### 📋 Future Enhancements (Not Yet Implemented)
- [ ] Authentication for admin pages
- [ ] Embeddings generation (vector column exists, not populated)
- [ ] Concept assignment to insights
- [ ] Search/filter functionality
- [ ] Bulk processing for multiple sources
- [ ] Background job queue (currently synchronous)

---

## Testing the Application

### 1. Start Development Server
```bash
npm run dev
```

### 2. Test Admin Flow
1. Navigate to `http://localhost:3000/admin/sources/new`
2. Fill in source details:
   - Type: `podcast`
   - Title: `Test Episode`
   - Authors: `Dr. Peter Attia`
   - Date: `2025-01-01`
   - Transcript: Paste a test transcript (can be short for testing)
3. Click "Create Source & Process"
4. Wait for processing (check console logs)
5. Navigate to `/admin/sources` to see the new source
6. Click "View" to see extracted insights at `/sources/[source-id]`

### 3. Expected Behavior
- Source is created in database
- Transcript is chunked (check console logs)
- Each chunk is sent to OpenAI
- Insights are extracted and deduplicated
- Insights appear on the source view page

---

## Architecture Decisions

### Why Next.js App Router?
- Server-side rendering for better SEO
- Built-in API routes (no separate backend needed)
- Server components for database queries
- Easy deployment to Vercel

### Why Supabase?
- PostgreSQL with pgvector (ready for embeddings)
- Built-in auth (ready for future admin protection)
- Real-time capabilities (future feature)
- Managed hosting

### Why Synchronous Processing?
- MVP simplicity
- Easier debugging
- Can move to background jobs later without changing DB/UI
- Pipeline is modular (`lib/pipeline.ts` can be extracted to worker)

### Why SHA256 Deduplication?
- Fast lookup via indexed hash
- Normalized comparison (handles whitespace/case differences)
- Prevents duplicate insights across sources

---

## Known Limitations & Considerations

1. **Processing Time:** Currently synchronous - long transcripts may timeout
   - **Solution:** Move to background job queue (e.g., BullMQ, Inngest)

2. **OpenAI Costs:** Using GPT-4o-mini for cost efficiency
   - Can upgrade to GPT-4o for better extraction quality
   - Consider caching/reusing similar chunks

3. **Error Handling:** Basic error handling in place
   - Could add retry logic for OpenAI failures
   - Could mark sources as "processing_failed" for retry

4. **Admin Security:** Admin pages are currently public
   - Should add Supabase Auth protection
   - Or use environment flag to enable/disable

5. **Embeddings:** Vector column exists but not populated
   - Will enable semantic search once implemented
   - Can use OpenAI embeddings API

---

## Next Steps for Dev Team

### Immediate (Testing & Refinement)
1. **Test with real transcript** - Use an actual Attia episode transcript
2. **Refine OpenAI prompt** - Adjust based on extraction quality
3. **Add loading states** - Show progress during processing
4. **Error handling UI** - Display errors to users

### Short-term (Polish)
1. **Add authentication** - Protect admin routes
2. **Improve UX** - Better feedback during processing
3. **Add pagination** - For sources list if it grows
4. **Add search** - Filter sources by title/type

### Medium-term (Features)
1. **Background processing** - Move pipeline to job queue
2. **Embeddings** - Generate and store vector embeddings
3. **Concept assignment** - Link insights to concepts
4. **Bulk upload** - Process multiple sources at once

### Long-term (Scale)
1. **ASR pipeline** - Automatic audio transcription
2. **RSS integration** - Auto-import podcast episodes
3. **Advanced search** - Semantic search using embeddings
4. **Analytics** - Track insight extraction quality

---

## Code Quality Notes

- ✅ TypeScript strict mode enabled
- ✅ Server/client components properly separated
- ✅ Environment variables properly scoped (server-only keys never in client)
- ✅ Error handling in place
- ✅ Modular pipeline (easy to extract to worker)
- ✅ Consistent code style
- ✅ No linter errors

---

## Questions for Dev Team

1. **OpenAI Model:** Should we upgrade from `gpt-4o-mini` to `gpt-4o` for better extraction quality?

2. **Processing:** Should we implement background job processing now, or wait until we have more data?

3. **Authentication:** What's the preferred approach for admin protection? Supabase Auth or environment flag?

4. **Prompt Engineering:** Should we refine the OpenAI prompt based on test results, or is the current structure acceptable?

5. **Embeddings:** When should we implement embeddings? Now or after we have more insights?

---

## Contact & Support

- **Branch:** `Library`
- **Supabase Project:** `ipxjckdsqgqkwaqhidqp`
- **Documentation:** See `README-MEDICAL-LIBRARY.md` and `MIGRATION-SUMMARY.md`

---

**Last Updated:** January 2025  
**Status:** Ready for testing and refinement
