// Shared configuration for Lifestyle Academy's 5 core health levers
// Levers are now a subset of concepts stored in the database
// This module provides a convenient API for accessing lever data

import { supabaseAdmin } from "./supabaseServer"
import type { Concept, LeverMetadata } from "./types"

export type Lever = {
  id: string // Derived from concept slug (e.g., "sleep", "exercise")
  name: string
  tagline: string
  description: string
  primaryBenefits: string[]
  conceptSlug: string // The concept slug from the database
  conceptId: string // The concept UUID
}

/**
 * Map concept slugs to lever IDs
 * This mapping ensures backward compatibility with existing code that uses lever IDs
 */
const SLUG_TO_LEVER_ID: Record<string, string> = {
  "sleep-circadian": "sleep",
  "exercise-training": "exercise",
  "nutrition-diet": "nutrition",
  "emotional-mental-health": "mental-health",
  "supplements-adjuncts": "drugs-supplements",
}

/**
 * Derive lever ID from concept slug
 */
function getLeverIdFromSlug(slug: string): string {
  return SLUG_TO_LEVER_ID[slug] || slug
}

/**
 * Transform a Concept with lever metadata into a Lever object
 */
function conceptToLever(concept: Concept): Lever | null {
  if (!concept.is_lever || !concept.lever_metadata || !concept.lever_order) {
    return null
  }

  const metadata = concept.lever_metadata as LeverMetadata
  const leverId = getLeverIdFromSlug(concept.slug)

  return {
    id: leverId,
    name: concept.name,
    tagline: metadata.tagline,
    description: concept.description || "",
    primaryBenefits: metadata.primaryBenefits || [],
    conceptSlug: concept.slug,
    conceptId: concept.id,
  }
}

// Module-level cache for levers (lasts for the lifetime of the process)
let cachedLevers: Lever[] | null = null

/**
 * Fetch all levers from the database
 * Results are cached for the lifetime of the process
 */
async function fetchLevers(): Promise<Lever[]> {
  if (cachedLevers) {
    return cachedLevers
  }

  if (!supabaseAdmin) {
    throw new Error("Supabase admin not configured")
  }

  const { data: concepts, error } = await supabaseAdmin
    .from("concepts")
    .select("*")
    .eq("is_lever", true)
    .order("lever_order", { ascending: true })

  if (error) {
    throw new Error(`Error fetching levers: ${error.message}`)
  }

  if (!concepts || concepts.length === 0) {
    throw new Error("No levers found in database. Run migrations 012 and 013 to set up levers.")
  }

  const levers = concepts
    .map(conceptToLever)
    .filter((lever: Lever | null): lever is Lever => lever !== null)

  if (levers.length !== 5) {
    console.warn(
      `Expected 5 levers but found ${levers.length}. Some lever concepts may be missing metadata.`
    )
  }

  cachedLevers = levers
  return levers
}

/**
 * Get all levers
 * @returns Array of all lever objects, ordered by lever_order
 */
export async function getAllLevers(): Promise<Lever[]> {
  return fetchLevers()
}

/**
 * Get a lever by its ID
 * @param id - The lever ID (e.g., "sleep", "exercise")
 * @returns The lever object, or undefined if not found
 */
export async function getLeverById(id: string): Promise<Lever | undefined> {
  const levers = await fetchLevers()
  return levers.find((lever) => lever.id === id)
}

/**
 * Get a lever by its associated concept slug
 * @param slug - The concept slug from the database (e.g., "sleep-circadian")
 * @returns The lever object, or undefined if not found
 */
export async function getLeverByConceptSlug(slug: string): Promise<Lever | undefined> {
  const levers = await fetchLevers()
  return levers.find((lever) => lever.conceptSlug === slug)
}

/**
 * Clear the lever cache (useful for testing or after updates)
 */
export function clearLeverCache(): void {
  cachedLevers = null
}

// For backward compatibility, export a synchronous getter that returns cached levers
// This will throw if levers haven't been fetched yet
let leversPromise: Promise<Lever[]> | null = null

/**
 * Synchronous access to cached levers (for client components that need immediate access)
 * WARNING: This will return an empty array if levers haven't been fetched yet.
 * Use the async functions (getAllLevers, etc.) in server components or when you can await.
 */
export function getCachedLevers(): Lever[] {
  return cachedLevers || []
}

/**
 * Pre-fetch levers (call this in server components to warm the cache)
 */
export async function prefetchLevers(): Promise<void> {
  if (!leversPromise) {
    leversPromise = fetchLevers()
  }
  await leversPromise
}
