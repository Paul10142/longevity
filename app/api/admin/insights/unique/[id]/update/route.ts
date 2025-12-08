/**
 * Update Unique Insight API Route
 * 
 * PATCH /api/admin/insights/unique/[id]/update
 * 
 * Updates the canonical statement of a unique insight
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: 'Supabase not configured' },
        { status: 500 }
      )
    }

    const { id } = await params
    const body = await request.json()
    const { canonical_statement } = body

    if (!canonical_statement || typeof canonical_statement !== 'string' || canonical_statement.trim().length === 0) {
      return NextResponse.json(
        { error: 'canonical_statement is required and must be a non-empty string' },
        { status: 400 }
      )
    }

    // Update the unique insight
    const { error: updateError } = await supabaseAdmin
      .from('unique_insights')
      .update({ canonical_statement: canonical_statement.trim() })
      .eq('id', id)

    if (updateError) {
      return NextResponse.json(
        { error: `Failed to update unique insight: ${updateError.message}` },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      message: 'Unique insight updated successfully'
    })
  } catch (error) {
    console.error('Error in update unique insight API:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}
