# Insight Review Guide

## Overview

This guide helps you efficiently critique existing insights to improve extraction accuracy. The goal is to build a solid foundation by identifying patterns in what's being extracted correctly vs. incorrectly.

## Best Approach for Review

### Option 1: Systematic Review by Source (Recommended)

**Why:** Reviewing insights within their source context helps you see:
- How insights relate to the original transcript
- Whether important information is being missed
- Whether irrelevant content is being extracted

**Steps:**
1. Go to `/admin/insights/review` - This shows insights grouped by source
2. For each source:
   - Click "View Source" to see the full transcript
   - Review insights in order (they're sorted by locator)
   - Note patterns:
     - **Missing insights:** Important information not extracted
     - **Low-value insights:** Should be filtered out
     - **Incorrect classifications:** Wrong evidence_type, confidence, importance, etc.
     - **Missing context:** Qualifiers or details that should be included

### Option 2: Bulk Export and Review

**Why:** Good for identifying patterns across all insights without source context

**Steps:**
1. Export insights:
   - JSON: `/api/admin/insights/export?format=json&limit=1000`
   - CSV: `/api/admin/insights/export?format=csv&limit=1000`
2. Review in spreadsheet or text editor
3. Look for patterns:
   - Common phrases in low-value insights
   - Systematic misclassifications
   - Missing qualifiers

### Option 3: Review by Category

**Why:** Focus on specific types of issues

**Review by:**
- **Importance:** Are importance ratings accurate? (`/admin/insights/review` - filter by importance)
- **Actionability:** Are actionability ratings appropriate?
- **Evidence Type:** Are evidence types correctly classified?
- **Confidence:** Are confidence levels appropriate?

## What to Look For

### 1. Low-Value Insights That Should Be Filtered

**Patterns to identify:**
- Meta-commentary about podcast structure
- Introductions of people
- Conflict of interest disclosures
- Generic statements without specificity
- Personal anecdotes unrelated to medical facts

**Action:** Add patterns to `filterLowValueInsights()` in `lib/pipeline.ts`

### 2. Missing Insights

**Questions to ask:**
- Are important protocols being extracted?
- Are key warnings/caveats captured?
- Are numeric details (doses, thresholds) preserved?
- Are population qualifiers included?

**Action:** Update extraction prompt in `lib/pipeline.ts` to emphasize these areas

### 3. Incorrect Classifications

**Check:**
- **Evidence Type:** Is "ExpertOpinion" being used when it should be "RCT"?
- **Confidence:** Is confidence too high/low for the evidence?
- **Importance:** Are importance ratings appropriate?
- **Actionability:** Should "High" actionability insights be marked differently?
- **Insight Type:** Are "Protocol" insights correctly identified?

**Action:** Update prompt guidance or add validation rules

### 4. Missing Context/Qualifiers

**Check:**
- Are population qualifiers included? (e.g., "postmenopausal women")
- Are doses/frequencies/durations captured?
- Are caveats and warnings included?
- Is context preserved? (e.g., "fasting state", "on medication")

**Action:** Strengthen prompt instructions about preserving qualifiers

## Making Changes

### 1. Update Filtering Rules

**File:** `lib/pipeline.ts` → `filterLowValueInsights()`

Add regex patterns to exclude low-value insights:
```typescript
const excludePatterns = [
  // Add your patterns here
  /pattern to exclude/i,
]
```

### 2. Update Extraction Prompt

**File:** `lib/pipeline.ts` → `EXTRACTION_SYSTEM_PROMPT_OPTIMIZED` or `EXTRACTION_SYSTEM_PROMPT_ORIGINAL`

**Key sections to modify:**
- **"IGNORE" section:** Add categories to skip
- **"INSIGHT TYPES" section:** Clarify what counts as an insight
- **"IMPORTANCE" section:** Refine importance criteria
- **"ACTIONABILITY" section:** Clarify actionability distinctions

### 3. Test Changes

After making changes:
1. Reprocess a test source: `/admin/sources/[id]` → "Reprocess"
2. Compare before/after insights
3. Verify improvements

## Review Checklist

For each insight, ask:

- [ ] **Should this be extracted?** (Is it clinically/behaviorally meaningful?)
- [ ] **Is it specific enough?** (Does it include numeric details, qualifiers?)
- [ ] **Is it classified correctly?** (Evidence type, confidence, importance, actionability)
- [ ] **Is context preserved?** (Population, dose, duration, caveats)
- [ ] **Is it actionable?** (Would this help a patient/clinician make decisions?)

## Common Issues and Fixes

### Issue: Too many generic insights
**Fix:** Strengthen "IGNORE" section in prompt, add filtering patterns

### Issue: Missing important details
**Fix:** Emphasize in prompt: "Preserve ALL numeric details and qualifiers"

### Issue: Incorrect importance ratings
**Fix:** Clarify importance criteria in prompt with examples

### Issue: Low-value insights getting through
**Fix:** Add patterns to `filterLowValueInsights()` function

## Next Steps After Review

1. **Document patterns** you find (create a list of common issues)
2. **Update extraction prompt** based on findings
3. **Add filtering rules** for low-value insights
4. **Reprocess sources** to see improvements
5. **Iterate** - review again and refine

## Tools Available

- **Review Page:** `/admin/insights/review` - Visual review with source context
- **Export API:** `/api/admin/insights/export` - Bulk export for analysis
- **Source Pages:** `/sources/[id]` - View insights in source context
- **Admin Concepts:** `/admin/concepts/[id]` - Review insights by topic

