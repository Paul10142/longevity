/**
 * Model Status API Route
 * 
 * GET /api/admin/insights/model-status - Get current model status
 * POST /api/admin/insights/model-status - Activate/deactivate a model
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'

export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: 'Supabase not configured' },
        { status: 500 }
      )
    }

    // Get active model
    const { data: activeModel } = await supabaseAdmin
      .from('deduplication_models')
      .select('*')
      .eq('is_active', true)
      .single()

    // Get all models
    const { data: allModels } = await supabaseAdmin
      .from('deduplication_models')
      .select('*')
      .order('version', { ascending: false })

    // Get prediction stats for active model
    let predictionStats = null
    if (activeModel) {
      const { count: totalPredictions } = await supabaseAdmin
        .from('model_predictions')
        .select('*', { count: 'exact', head: true })
        .eq('model_id', activeModel.id)

      const { count: correctPredictions } = await supabaseAdmin
        .from('model_predictions')
        .select('*', { count: 'exact', head: true })
        .eq('model_id', activeModel.id)
        .eq('is_correct', true)
        .not('actual_label', 'is', null)

      const { count: reviewedPredictions } = await supabaseAdmin
        .from('model_predictions')
        .select('*', { count: 'exact', head: true })
        .eq('model_id', activeModel.id)
        .not('actual_label', 'is', null)

      predictionStats = {
        total: totalPredictions || 0,
        reviewed: reviewedPredictions || 0,
        correct: correctPredictions || 0,
        accuracy: reviewedPredictions && reviewedPredictions > 0
          ? ((correctPredictions || 0) / reviewedPredictions * 100).toFixed(2)
          : null
      }
    }

    return NextResponse.json({
      activeModel: activeModel || null,
      allModels: allModels || [],
      predictionStats
    })
  } catch (error) {
    console.error('Error fetching model status:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: 'Supabase not configured' },
        { status: 500 }
      )
    }

    const body = await request.json()
    const { modelId, action } = body

    if (!modelId || !action) {
      return NextResponse.json(
        { error: 'modelId and action (activate|deactivate) required' },
        { status: 400 }
      )
    }

    if (action === 'activate') {
      // Deactivate all models first
      await supabaseAdmin
        .from('deduplication_models')
        .update({ is_active: false })
        .eq('is_active', true)

      // Activate the specified model
      const { error: updateError } = await supabaseAdmin
        .from('deduplication_models')
        .update({ is_active: true })
        .eq('id', modelId)

      if (updateError) {
        return NextResponse.json(
          { error: `Failed to activate model: ${updateError.message}` },
          { status: 500 }
        )
      }

      return NextResponse.json({
        success: true,
        message: 'Model activated successfully'
      })
    } else if (action === 'deactivate') {
      const { error: updateError } = await supabaseAdmin
        .from('deduplication_models')
        .update({ is_active: false })
        .eq('id', modelId)

      if (updateError) {
        return NextResponse.json(
          { error: `Failed to deactivate model: ${updateError.message}` },
          { status: 500 }
        )
      }

      return NextResponse.json({
        success: true,
        message: 'Model deactivated successfully'
      })
    } else {
      return NextResponse.json(
        { error: 'Invalid action. Use "activate" or "deactivate"' },
        { status: 400 }
      )
    }
  } catch (error) {
    console.error('Error updating model status:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
