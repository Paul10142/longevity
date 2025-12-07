# Protocol & Article Regeneration Strategy Report

**Date:** January 2025  
**Context:** After implementing insight prioritization system, need to decide how to handle existing protocols/articles

---

## Background

We're implementing a new **tiered prioritization system** for protocol and article generation that:
- Ensures new insights (last 30 days) are always included
- Limits insights sent to OpenAI to ~350 (stays within token limits)
- Uses composite scoring (importance + actionability + evidence strength + recency)

**Current State:**
- Existing protocols/articles were generated from ALL insights (no prioritization)
- Some topics may have 500-1000+ insights
- Existing protocols/articles may be missing recent insights or may be too long/dense

**Question:** How should we handle regeneration of existing protocols/articles?

---

## Option 1: Regenerate All Immediately (Automated)

**Approach:**
- After deploying prioritization system, automatically regenerate all protocols/articles
- Process in background, one concept at a time
- No user intervention required

**Pros:**
- ✅ Ensures all protocols/articles use new prioritization
- ✅ Includes recent insights automatically
- ✅ Consistent quality across all topics
- ✅ No manual work required

**Cons:**
- ❌ High upfront cost (OpenAI API calls for all concepts)
- ❌ Time-consuming (could take hours for 50-100 concepts)
- ❌ May change existing protocols/articles that users have bookmarked/referenced
- ❌ No control over which ones to regenerate
- ❌ Risk of breaking existing links/references if content changes significantly

**Cost Estimate:**
- 50 concepts × 2 articles (patient + clinician) = 100 articles
- 50 concepts × 1 protocol = 50 protocols
- Total: 150 generations
- Cost: ~$0.50-1.00 per generation = **$75-150 total**
- Time: ~2-5 minutes per generation = **5-12 hours total** (if sequential)

---

## Option 2: Manual Regeneration (On-Demand)

**Approach:**
- Provide admin UI to regenerate individual protocols/articles
- Admin selects which concepts to regenerate
- Triggered manually when needed

**Pros:**
- ✅ Full control over what gets regenerated
- ✅ Lower upfront cost (only regenerate when needed)
- ✅ Can prioritize important topics first
- ✅ Can review changes before deploying
- ✅ Preserves existing content until explicitly updated

**Cons:**
- ❌ Manual work required
- ❌ Easy to forget to regenerate important topics
- ❌ Inconsistent (some topics updated, others not)
- ❌ Recent insights may be missing from non-regenerated topics

**Implementation:**
- Add "Regenerate" button to each topic's admin tab
- Add bulk selection UI for multiple topics
- Show last regeneration date

---

## Option 3: Hybrid Approach (Smart Regeneration)

**Approach:**
- Automatically regenerate topics with new insights (last 30 days)
- Provide manual regeneration for all other topics
- Show "Needs Regeneration" indicator for topics with new insights

**Pros:**
- ✅ Ensures recent insights are always included
- ✅ Lower cost (only regenerate when new insights exist)
- ✅ Automatic for high-priority cases (new insights)
- ✅ Manual control for other cases
- ✅ Clear indication of what needs updating

**Cons:**
- ❌ More complex implementation
- ❌ Still requires manual work for topics without recent insights
- ❌ Need to track "last regeneration date" vs "new insights date"

**Implementation:**
- Track `last_regenerated_at` timestamp on protocols/articles
- Compare to `MAX(insight.created_at)` for concept
- Auto-regenerate if new insights exist since last regeneration
- Show "Needs Regeneration" badge in admin UI
- Provide "Regenerate All" button for manual bulk regeneration

---

## Option 4: Staged Rollout (Phased Regeneration)

**Approach:**
- Phase 1: Regenerate top 10-20 most important concepts (manually selected)
- Phase 2: Regenerate concepts with most new insights (automated)
- Phase 3: Regenerate remaining concepts over time (manual or scheduled)

**Pros:**
- ✅ Spreads cost over time
- ✅ Allows testing/validation before full rollout
- ✅ Prioritizes high-impact topics first
- ✅ Reduces risk of breaking changes

**Cons:**
- ❌ Most complex to implement
- ❌ Requires tracking regeneration status
- ❌ Inconsistent state during rollout period

---

## Recommendation: Option 3 (Hybrid Approach)

**Rationale:**
1. **Cost-effective**: Only regenerates when new insights exist (most important case)
2. **User control**: Manual regeneration available for other cases
3. **Clear indicators**: Shows what needs updating
4. **Balanced**: Automatic for critical cases, manual for others

**Implementation Details:**

1. **Database Changes:**
   - Add `last_regenerated_at` to `topic_protocols` table
   - Add `last_regenerated_at` to `topic_articles` table
   - Track when each was last regenerated

2. **Auto-Regeneration Logic:**
   ```typescript
   // After new insights are added to a concept
   const latestInsightDate = MAX(insight.created_at WHERE concept_id = X)
   const lastRegenerated = protocol.last_regenerated_at
   
   if (latestInsightDate > lastRegenerated) {
     // Auto-regenerate protocol/article
     await regenerateProtocol(conceptId)
   }
   ```

3. **Admin UI:**
   - Show "Needs Regeneration" badge on topics with new insights
   - "Regenerate" button on each topic's admin tab
   - "Regenerate All" bulk action
   - Show last regeneration date

4. **Background Job:**
   - After source processing, check all linked concepts
   - Auto-regenerate protocols/articles for concepts with new insights
   - Log progress silently

**Cost Estimate:**
- Initial: Only concepts with new insights (maybe 10-20) = **$15-40**
- Ongoing: Only when new sources added = **$1-5 per new source**

---

## Alternative: Option 2 (Manual Only) if Cost is Concern

If upfront cost is a major concern, **Option 2 (Manual Only)** is safer:
- No automatic regeneration
- Admin manually triggers regeneration when needed
- Lower risk, full control
- Can regenerate in batches over time

**Implementation:**
- Add "Regenerate" button to topic admin tab
- Add bulk selection for multiple topics
- Show "Last regenerated" date
- Show "New insights since last regeneration" count

---

## Decision Matrix

| Criteria | Option 1 (Auto All) | Option 2 (Manual) | Option 3 (Hybrid) | Option 4 (Staged) |
|----------|---------------------|-------------------|-------------------|-------------------|
| **Upfront Cost** | High ($75-150) | Low ($0) | Medium ($15-40) | Low-Medium ($20-60) |
| **Ongoing Cost** | Low | Low | Low | Low |
| **User Control** | None | Full | Partial | Partial |
| **Automation** | Full | None | Partial | Partial |
| **Complexity** | Low | Low | Medium | High |
| **Risk** | Medium | Low | Low | Low |
| **Time to Complete** | 5-12 hours | Ongoing | Ongoing | Weeks |

---

## Questions for Team Discussion

1. **Budget**: Is $75-150 upfront cost acceptable for Option 1, or prefer lower-cost options?

2. **Timeline**: Do we need all protocols/articles updated immediately, or can we do it gradually?

3. **User Impact**: Will changing existing protocols/articles break user workflows/bookmarks?

4. **Priority**: Which topics are most important to update first? (Can inform Option 4)

5. **Automation Preference**: Do we want automatic regeneration for new insights, or prefer manual control?

6. **Quality Control**: Do we need to review regenerated content before it goes live, or trust the system?

---

## Recommendation Summary

**Primary Recommendation: Option 3 (Hybrid Approach)**
- Auto-regenerate when new insights exist (ensures recent info included)
- Manual regeneration available for other cases
- Clear indicators of what needs updating
- Balanced cost and automation

**Fallback: Option 2 (Manual Only)** if:
- Budget is tight
- Need full control over what gets regenerated
- Want to review all changes before deploying

---

**Next Steps:**
1. Team reviews this document
2. Decide on approach (Option 1, 2, 3, or 4)
3. Implement chosen approach
4. Monitor cost and quality after deployment

