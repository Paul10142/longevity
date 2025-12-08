/**
 * Export Training Data API Route
 * 
 * GET /api/admin/insights/export-training-data
 * 
 * Exports manual merge decisions as training data for fine-tuning
 * Supports OpenAI JSONL format and custom JSON format
 */

import { NextRequest, NextResponse } from 'next/server'
import { exportTrainingData, convertToOpenAIFormat, convertToCustomJSONFormat } from '@/lib/trainingDataExport'
import { supabaseAdmin } from '@/lib/supabaseServer'

export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: 'Supabase not configured' },
        { status: 500 }
      )
    }

    const searchParams = request.nextUrl.searchParams
    const format = searchParams.get('format') || 'json' // 'json' or 'openai_jsonl'
    const includeStats = searchParams.get('stats') === 'true'

    // Export training data
    const data = await exportTrainingData()

    if (format === 'openai_jsonl') {
      // Combine positive and negative examples
      const allExamples = [...data.positive, ...data.negative]
      const jsonl = convertToOpenAIFormat(allExamples)

      return new NextResponse(jsonl, {
        headers: {
          'Content-Type': 'application/jsonl',
          'Content-Disposition': `attachment; filename="training-data-${new Date().toISOString().split('T')[0]}.jsonl"`
        }
      })
    } else {
      // Custom JSON format
      const json = convertToCustomJSONFormat([...data.positive, ...data.negative])

      const response: any = {
        format: 'custom_json',
        exported_at: new Date().toISOString(),
        total_examples: data.total,
        positive_examples: data.positive.length,
        negative_examples: data.negative.length,
        examples: JSON.parse(json)
      }

      if (includeStats) {
        response.stats = data.stats
      }

      return NextResponse.json(response, {
        headers: {
          'Content-Disposition': `attachment; filename="training-data-${new Date().toISOString().split('T')[0]}.json"`
        }
      })
    }
  } catch (error) {
    console.error('Error exporting training data:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}
