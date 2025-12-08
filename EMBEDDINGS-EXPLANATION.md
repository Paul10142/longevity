# What Are Embeddings?

## Simple Explanation

**Embeddings** are numerical representations of text that capture meaning. Think of them as a "fingerprint" for each insight that captures what it's about, not just the exact words.

## How They Work

1. **Input**: An insight statement like "Testosterone levels peak in the morning"
2. **Process**: OpenAI's embedding model converts it into a list of 1,536 numbers
3. **Output**: A vector (array of numbers) that represents the semantic meaning

## Why We Use Them

### For Clustering (Finding Similar Insights)

When we want to find insights that say the same thing in different words:
- "Testosterone is highest in the morning"
- "Morning testosterone levels are elevated"
- "Testosterone peaks during early hours"

These have **different words** but **similar meaning**. Embeddings capture that similarity.

### How Similarity Works

- Each insight gets converted to a 1,536-dimensional vector
- We calculate the "distance" between vectors using cosine similarity
- Similar insights have vectors that are close together
- We use a threshold (0.90) to determine if insights are similar enough to cluster

## Example

```
Insight A: "Testosterone peaks in the morning"
Embedding: [0.123, -0.456, 0.789, ...] (1536 numbers)

Insight B: "Morning testosterone levels are highest"  
Embedding: [0.125, -0.454, 0.791, ...] (1536 numbers)

Similarity: 0.92 (very similar - would be clustered together)
```

## Why Some Insights Are Missing Embeddings

1. **Created before embeddings were added** - Older insights from before the feature existed
2. **Async generation failed** - The pipeline generates embeddings asynchronously (fire-and-forget), so if there was an error, it was logged but didn't stop processing
3. **API rate limits** - OpenAI API might have rate-limited some requests
4. **Network issues** - Temporary failures during embedding generation

## Why We Generate Them First

**Before clustering**, we now:
1. ✅ Generate all missing embeddings first (ensures 100% coverage)
2. ✅ Then run clustering (faster, more reliable)

This ensures:
- **Reliability**: All insights have embeddings before clustering
- **Performance**: Clustering is faster when embeddings are ready
- **Accuracy**: No skipped insights due to missing embeddings

## Technical Details

- **Model**: OpenAI `text-embedding-3-small`
- **Dimensions**: 1,536 numbers per embedding
- **Cost**: ~$0.02 per 1M tokens (very cheap)
- **Storage**: Stored in PostgreSQL as `vector(1536)` type using pgvector extension
