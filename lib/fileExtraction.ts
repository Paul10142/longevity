import EPub from "epub2"

/**
 * Extract text content from an EPUB file
 */
export async function extractTextFromEPUB(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    // Convert File to Buffer
    file.arrayBuffer()
      .then(buffer => {
        const epub = new EPub(Buffer.from(new Uint8Array(buffer)) as any)
        const chapters: string[] = []
        let chapterCount = 0
        let hasError = false

        epub.on("end", () => {
          // Check if there are any chapters
          if (!epub.flow || epub.flow.length === 0) {
            reject(new Error("EPUB file contains no chapters"))
            return
          }

          // Process all chapters
          epub.flow.forEach((chapter: any) => {
            epub.getChapter(chapter.id, (error: Error, text?: string) => {
              if (hasError) return // Don't process if we already errored
              
              if (error) {
                console.error(`Error reading chapter ${chapter.id}:`, error)
                // Continue processing other chapters even if one fails
              } else if (text) {
                // Remove HTML tags and extract text
                const textContent = text
                  .replace(/<[^>]*>/g, " ") // Remove HTML tags
                  .replace(/\s+/g, " ") // Normalize whitespace
                  .trim()
                
                if (textContent) {
                  chapters.push(textContent)
                }
              }
              
              chapterCount++
              
              // When all chapters are processed, join them
              if (chapterCount === epub.flow.length) {
                if (chapters.length === 0) {
                  reject(new Error("No readable content found in EPUB file"))
                } else {
                  const fullText = chapters.join("\n\n")
                  resolve(fullText)
                }
              }
            })
          })
        })

        epub.on("error", (error: Error) => {
          hasError = true
          reject(new Error(`Failed to parse EPUB: ${error.message}`))
        })

        epub.parse()
      })
      .catch(reject)
  })
}

/**
 * Extract text content from a PDF file
 * Note: This function must be called server-side only (in API routes)
 */
export async function extractTextFromPDF(file: File): Promise<string> {
  try {
    // pdf-parse v2 uses PDFParse class that must be instantiated
    // Try dynamic import first (ESM), then fallback to require (if available)
    let PDFParseClass: any
    
    try {
      // Try dynamic import (works in ESM mode)
      const pdfParseModule = await import("pdf-parse")
      // The class is exported as PDFParse property
      PDFParseClass = pdfParseModule.PDFParse
    } catch (importError) {
      // Fallback to require if dynamic import fails
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const pdfParseRequire = require("pdf-parse")
      PDFParseClass = pdfParseRequire.PDFParse
    }
    
    if (!PDFParseClass || typeof PDFParseClass !== 'function') {
      throw new Error(`PDFParse class not found in pdf-parse module`)
    }
    
    // Get file as Uint8Array (pdf-parse v2 requires Uint8Array, not Buffer)
    const arrayBuffer = await file.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)
    
    // Create instance of PDFParse class with the PDF data
    const parser = new PDFParseClass(uint8Array)
    
    // Call getText() method to extract text
    const result = await parser.getText()
    
    if (!result || !result.text || result.text.trim().length === 0) {
      throw new Error("PDF file contains no extractable text")
    }
    
    // Preserve paragraph structure but normalize excessive whitespace
    // Replace multiple spaces with single space, but preserve newlines
    let text = result.text
      .replace(/[ \t]+/g, " ") // Normalize spaces and tabs to single space
      .replace(/\n{3,}/g, "\n\n") // Normalize 3+ newlines to double newline
      .trim()
    
    // If text has no paragraph breaks, add them at sentence boundaries for better chunking
    if (!text.includes("\n\n") && text.length > 1000) {
      // Add double newline after sentence endings (period, exclamation, question mark) followed by space and capital letter
      text = text.replace(/([.!?])\s+([A-Z])/g, "$1\n\n$2")
    }
    
    return text
  } catch (error) {
    throw new Error(`Failed to extract text from PDF: ${error instanceof Error ? error.message : "Unknown error"}`)
  }
}

/**
 * Extract text from a file based on its type
 */
export async function extractTextFromFile(file: File): Promise<string> {
  const fileType = file.type
  const fileName = file.name.toLowerCase()

  // EPUB files
  if (fileType === "application/epub+zip" || fileName.endsWith(".epub")) {
    return extractTextFromEPUB(file)
  }

  // Plain text files
  if (fileType === "text/plain" || fileName.endsWith(".txt")) {
    return file.text()
  }

  // HTML files
  if (fileType === "text/html" || fileName.endsWith(".html") || fileName.endsWith(".htm")) {
    const html = await file.text()
    // Simple HTML tag removal (could be improved with a proper HTML parser)
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "") // Remove scripts
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "") // Remove styles
      .replace(/<[^>]*>/g, " ") // Remove HTML tags
      .replace(/\s+/g, " ") // Normalize whitespace
      .trim()
  }

  // PDF files
  if (fileType === "application/pdf" || fileName.endsWith(".pdf")) {
    return extractTextFromPDF(file)
  }

  // Default: try to read as text
  try {
    return file.text()
  } catch (error) {
    throw new Error(`Unsupported file type: ${fileType || "unknown"}. Supported formats: EPUB, TXT, HTML, PDF`)
  }
}
