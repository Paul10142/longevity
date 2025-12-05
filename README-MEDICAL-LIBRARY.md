# Medical Library - ClancyMedical MVP

This is the Medical Library feature for LifestyleAcademy, built on Next.js 16 with Supabase and OpenAI integration.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment variables:**
   Copy `.env.example` to `.env.local` and fill in your values:
   ```bash
   cp .env.example .env.local
   ```

   Required environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL` - Your Supabase project URL
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` - Your Supabase publishable key (`sb_publishable_...` format)
   - `SUPABASE_SECRET_KEY` - Your Supabase secret key (`sb_secret_...` format, server-only)
   - `OPENAI_API_KEY` - Your OpenAI API key
   
   **Note:** Supabase has updated their API key system (2025). Use the new `sb_publishable_...` and `sb_secret_...` formats for future compatibility. Legacy JWT keys (`eyJ...`) still work but will be deprecated in late 2026.

3. **Database Schema:**
   The schema has already been applied via Supabase migration. It includes:
   - `sources` - Podcast episodes, books, videos, articles
   - `chunks` - Segmented transcript content
   - `insights` - Extracted canonical statements
   - `insight_sources` - Links insights to sources
   - `concepts` - For future concept organization
   - `insight_concepts` - Links insights to concepts

4. **Run the development server:**
   ```bash
   npm run dev
   ```

## Features

### Admin Interface
- **`/admin/sources`** - List all sources
- **`/admin/sources/new`** - Create a new source and paste transcript

### Public Interface
- **`/medical-library`** - Main Medical Library page
- **`/sources/[id]`** - View insights for a specific source

## How It Works

1. **Create a Source:**
   - Go to `/admin/sources/new`
   - Fill in source metadata (type, title, authors, date, URL)
   - Paste the full transcript
   - Submit the form

2. **Processing Pipeline:**
   - Transcript is split into chunks (~1000-1500 characters)
   - Each chunk is sent to OpenAI for insight extraction
   - Insights are deduplicated using SHA256 hash of normalized statement
   - Insights are linked to the source with locators (seg-001, seg-002, etc.)

3. **View Insights:**
   - Navigate to `/sources/[source-id]` to see all extracted insights
   - Each insight shows:
     - Statement (canonical paraphrase)
     - Context note (if any)
     - Evidence type (RCT, Cohort, etc.)
     - Confidence level
     - Qualifiers (population, dose, duration, etc.)
     - Locator (which chunk it came from)

## Architecture Notes

- **Supabase Client:** `lib/supabaseClient.ts` - Client-side (uses `sb_publishable_...` key, respects RLS)
- **Supabase Server:** `lib/supabaseServer.ts` - Server-side (uses `sb_secret_...` key, bypasses RLS)
- **Processing Pipeline:** `lib/pipeline.ts` - Modular, can be moved to a worker service later
- **API Routes:** `app/api/admin/sources/route.ts` - Handles source creation and processing

## Next Steps

- Add embeddings for semantic search
- Add concept assignment to insights
- Improve OpenAI prompt for better extraction
- Add authentication for admin pages
- Add bulk processing for multiple sources
