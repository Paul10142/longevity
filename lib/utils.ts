import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Helper to capitalize first letter of each word
export function capitalizeWords(str: string): string {
  return str.split(' ').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ')
}

// Helper to format evidence type (handles camelCase like "ExpertOpinion" → "Expert Opinion")
export function formatEvidenceType(type: string): string {
  if (type === 'RCT') return 'RCT'
  if (type === 'MetaAnalysis') return 'Meta-Analysis'
  
  // Handle camelCase: insert space before capital letters, then capitalize
  const spaced = type.replace(/([a-z])([A-Z])/g, '$1 $2')
  return capitalizeWords(spaced)
}


