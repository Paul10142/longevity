import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured" },
        { status: 500 }
      )
    }

    const { id } = await params
    const body = await request.json()
    const { statement } = body

    if (!statement || typeof statement !== 'string' || statement.trim().length === 0) {
      return NextResponse.json(
        { error: "Statement is required and must be a non-empty string" },
        { status: 400 }
      )
    }

    // Update the insight statement
    const { data: updatedInsight, error: updateError } = await supabaseAdmin
      .from('insights')
      .update({ statement: statement.trim() })
      .eq('id', id)
      .select()
      .single()

    if (updateError || !updatedInsight) {
      throw new Error(`Failed to update insight: ${updateError?.message || 'Unknown error'}`)
    }

    return NextResponse.json({
      success: true,
      insight: updatedInsight,
      message: "Insight updated successfully"
    })
  } catch (error) {
    console.error("Error in PATCH /api/admin/insights/[id]/update:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}


