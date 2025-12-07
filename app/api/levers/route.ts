import { NextResponse } from "next/server"
import { getAllLevers } from "@/lib/levers"

// Cache for 5 minutes
export const revalidate = 300

export async function GET() {
  try {
    const levers = await getAllLevers()
    return NextResponse.json(levers)
  } catch (error) {
    console.error("Error fetching levers:", error)
    return NextResponse.json(
      { error: "Failed to fetch levers" },
      { status: 500 }
    )
  }
}

