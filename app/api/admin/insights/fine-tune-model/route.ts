/**
 * Fine-Tune Model API Route
 * 
 * POST /api/admin/insights/fine-tune-model
 * 
 * Creates a fine-tuning job using exported training data
 * Supports OpenAI fine-tuning API
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'
import { exportTrainingData, convertToOpenAIFormat } from '@/lib/trainingDataExport'
import OpenAI from 'openai'

function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY environment variable')
  }
  return new OpenAI({ apiKey })
}

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: 'Supabase not configured' },
        { status: 500 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const { baseModel = 'gpt-4o-mini-2024-07-18', useExistingExport = false } = body

    // Step 1: Export training data
    console.log('[Fine-Tune] Exporting training data...')
    const trainingData = await exportTrainingData()

    if (trainingData.total === 0) {
      return NextResponse.json(
        { error: 'No training data available. Please create some manual merge decisions first.' },
        { status: 400 }
      )
    }

    if (trainingData.positive.length < 10 || trainingData.negative.length < 10) {
      return NextResponse.json(
        { 
          error: `Insufficient training data. Need at least 10 positive and 10 negative examples. Found ${trainingData.positive.length} positive and ${trainingData.negative.length} negative.`,
          stats: trainingData.stats
        },
        { status: 400 }
      )
    }

    // Step 2: Convert to OpenAI format
    console.log('[Fine-Tune] Converting to OpenAI format...')
    const allExamples = [...trainingData.positive, ...trainingData.negative]
    const jsonl = convertToOpenAIFormat(allExamples)

    // Step 3: Upload file to OpenAI
    console.log('[Fine-Tune] Uploading training file to OpenAI...')
    const openai = getOpenAI()
    
    // Create a File object from the JSONL string
    const blob = new Blob([jsonl], { type: 'application/jsonl' })
    const file = new File([blob], `training-data-${Date.now()}.jsonl`, { type: 'application/jsonl' })

    // Note: OpenAI's file upload API expects a File object or FormData
    // We'll need to use the Files API
    const formData = new FormData()
    formData.append('file', file)
    formData.append('purpose', 'fine-tune')

    // Upload file using OpenAI SDK
    const trainingFile = await openai.files.create({
      file: file as any,
      purpose: 'fine-tune'
    })

    console.log(`[Fine-Tune] Uploaded file: ${trainingFile.id}`)

    // Step 4: Create fine-tuning job
    console.log('[Fine-Tune] Creating fine-tuning job...')
    const fineTuneJob = await openai.fineTuning.jobs.create({
      training_file: trainingFile.id,
      model: baseModel,
      hyperparameters: {
        n_epochs: 3 // Adjust based on dataset size
      }
    })

    console.log(`[Fine-Tune] Created job: ${fineTuneJob.id}`)

    // Step 5: Get next version number
    const { data: latestModel } = await supabaseAdmin
      .from('deduplication_models')
      .select('version')
      .order('version', { ascending: false })
      .limit(1)
      .single()

    const nextVersion = (latestModel?.version || 0) + 1

    // Step 6: Create model record (initially inactive)
    const { data: modelRecord, error: modelError } = await supabaseAdmin
      .from('deduplication_models')
      .insert({
        model_id: fineTuneJob.id, // Will update with actual model ID when job completes
        version: nextVersion,
        training_data_count: trainingData.total,
        positive_examples: trainingData.positive.length,
        negative_examples: trainingData.negative.length,
        is_active: false, // Will activate after evaluation
        notes: `Fine-tuning job created. Base model: ${baseModel}`
      })
      .select('id')
      .single()

    if (modelError) {
      console.error('Error creating model record:', modelError)
      // Don't fail - the job is created, we can update the record later
    }

    // Step 7: Record training data export
    await supabaseAdmin
      .from('training_data_exports')
      .insert({
        positive_examples: trainingData.positive.length,
        negative_examples: trainingData.negative.length,
        total_examples: trainingData.total,
        format: 'openai_jsonl',
        model_version: nextVersion,
        exported_by: 'system'
      })

    return NextResponse.json({
      success: true,
      fineTuneJobId: fineTuneJob.id,
      trainingFileId: trainingFile.id,
      modelVersion: nextVersion,
      trainingDataStats: trainingData.stats,
      message: `Fine-tuning job created. Monitor progress at: https://platform.openai.com/finetune/${fineTuneJob.id}`
    })
  } catch (error) {
    console.error('Error creating fine-tuning job:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}

/**
 * Check fine-tuning job status and update model record
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const jobId = searchParams.get('jobId')

    if (!jobId) {
      return NextResponse.json(
        { error: 'jobId parameter required' },
        { status: 400 }
      )
    }

    const openai = getOpenAI()
    const job = await openai.fineTuning.jobs.retrieve(jobId)

    // If job is complete, update model record with actual model ID
    if (job.status === 'succeeded' && job.fine_tuned_model) {
      const { data: modelRecord } = await supabaseAdmin
        ?.from('deduplication_models')
        .select('id')
        .eq('model_id', jobId) // Match by job ID initially
        .single()

      if (modelRecord) {
        await supabaseAdmin
          .from('deduplication_models')
          .update({
            model_id: job.fine_tuned_model, // Update with actual model ID
            notes: `Fine-tuning completed. Original job: ${jobId}`
          })
          .eq('id', modelRecord.id)
      }
    }

    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      fineTunedModel: job.fine_tuned_model,
      trainedTokens: job.trained_tokens,
      error: job.error
    })
  } catch (error) {
    console.error('Error checking fine-tuning job:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
