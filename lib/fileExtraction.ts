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

  // PDF files (would need pdf-parse or similar)
  if (fileType === "application/pdf" || fileName.endsWith(".pdf")) {
    throw new Error("PDF files are not yet supported. Please convert to EPUB or plain text first.")
  }

  // Default: try to read as text
  try {
    return file.text()
  } catch (error) {
    throw new Error(`Unsupported file type: ${fileType || "unknown"}. Supported formats: EPUB, TXT, HTML`)
  }
}
