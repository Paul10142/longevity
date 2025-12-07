# Insight Extraction Reliability Strategy

## Problem Statement

When processing the same transcript multiple times, we observed significant variance in the number of insights extracted:
- Run 1: 308 insights created
- Run 2: 243 insights created (but 433 total linked)
- This indicates ~118 insights from Run 1 were not found in Run 2

This non-determinism raises concerns about:
1. **Completeness**: Are we missing important insights?
2. **Trust**: Can we rely on the extraction process?
3. **Consistency**: Should the same input always produce the same output?

## Root Causes

1. **Model Non-Determinism**: `gpt-5-mini` doesn't support temperature control (defaults to 1.0)
2. **LLM Variability**: Even with temperature control, LLMs have inherent variability
3. **Prompt Ambiguity**: The model may interpret "comprehensive" differently across runs

## Solutions Implemented

### 1. Deterministic Model Configuration ✅
- **Changed**: `gpt-5-mini` → `gpt-4o-mini`
- **Added**: `temperature: 0.2` for consistent outputs
- **Impact**: Same input should now produce much more consistent results

### 2. Enhanced Prompt for Comprehensiveness ✅
- **Added**: Explicit instruction: "Extract EVERY insight that meets the criteria"
- **Added**: "Be comprehensive and exhaustive"
- **Added**: "When in doubt, include the insight rather than excluding it"
- **Impact**: Model should be more thorough in extraction

### 3. Infrastructure for Future Enhancements
- **Added**: `ENSEMBLE_RUNS` constant (currently set to 1)
- **Purpose**: Enable running extraction multiple times and merging unique insights
- **Status**: Ready for implementation when needed

## Recommended Approach

### Immediate (Implemented)
1. ✅ Use `gpt-4o-mini` with `temperature: 0.2`
2. ✅ Enhanced prompt for comprehensiveness
3. ✅ Monitor consistency in next reprocess

### Short-term (If Issues Persist)
1. **Ensemble Mode**: Run extraction 2-3 times per chunk, merge unique insights
   - Pros: Catches insights missed in single runs
   - Cons: 2-3x cost and processing time
   - Implementation: Set `ENSEMBLE_RUNS = 2` or `3`

2. **Run Comparison Tooling**: Compare insights between runs to identify gaps
   - Track which insights appear consistently vs. sporadically
   - Flag chunks with high variance for manual review

3. **Confidence Scoring**: Track how often each insight appears across runs
   - Insights that appear in all runs = high confidence
   - Insights that appear sporadically = lower confidence, may need review

### Long-term (If Needed)
1. **Hybrid Approach**: Use deterministic extraction + ensemble for critical sources
2. **Validation Layer**: Post-process to check for common insight patterns that might be missing
3. **Human Review**: Flag sources with high variance for manual verification

## Testing Strategy

1. **Reprocess source #368** with new configuration
2. **Compare results**:
   - Number of insights should be much more consistent
   - If variance is still >10%, consider ensemble mode
3. **Monitor** other sources for consistency

## Cost Considerations

- **Current**: Single run with `gpt-4o-mini` (similar cost to `gpt-5-mini`)
- **Ensemble (2x)**: 2x cost, 2x time
- **Ensemble (3x)**: 3x cost, 3x time

**Recommendation**: Start with single deterministic run. Only enable ensemble if variance remains high after prompt improvements.

## Configuration

Current settings in `lib/pipeline.ts`:
```typescript
const EXTRACTION_MODEL = 'gpt-4o-mini'
const EXTRACTION_TEMPERATURE = 0.2
const ENSEMBLE_RUNS = 1 // Set to 2-3 for ensemble mode
```

## Next Steps

1. ✅ Test with source #368 reprocess
2. Monitor consistency across multiple sources
3. If variance >10%, consider enabling ensemble mode
4. Add run comparison tooling if needed

