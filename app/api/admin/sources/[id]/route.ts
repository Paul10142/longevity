import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured. Please set up environment variables." },
        { status: 500 }
      )
    }

    const { id } = await params
    const body = await request.json()
    const { title, authors, date, url, transcript } = body

    // Build update object with only provided fields
    const updates: any = {}
    if (title !== undefined) updates.title = title
    if (authors !== undefined) updates.authors = authors
    if (date !== undefined) updates.date = date || null
    if (url !== undefined) updates.url = url || null
    if (transcript !== undefined) updates.transcript = transcript

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "No fields to update" },
        { status: 400 }
      )
    }

    const { data: source, error: updateError } = await supabaseAdmin
      .from("sources")
      .update(updates)
      .eq("id", id)
      .select()
      .single()

    if (updateError || !source) {
      console.error("Error updating source:", updateError)
      return NextResponse.json(
        {
          error: `Failed to update source: ${updateError?.message}`,
          details: updateError?.details || null,
          hint: updateError?.hint || null,
          code: updateError?.code || null
        },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      source,
      message: "Source updated successfully",
    })
  } catch (error) {
    console.error("Error in PATCH /api/admin/sources/[id]:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
