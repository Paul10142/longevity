import { NextResponse } from "next/server"
import OpenAI from 'openai'

// Lazy initialization of OpenAI client to avoid errors during build when API key is not available
let openaiInstance: OpenAI | null = null

function getOpenAI(): OpenAI {
  if (!openaiInstance) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('Missing credentials. Please pass an `apiKey`, or set the `OPENAI_API_KEY` environment variable.')
    }
    openaiInstance = new OpenAI({
      apiKey,
    })
  }
  return openaiInstance
}

export async function GET() {
  try {
    console.log('Testing OpenAI API connection...')
    console.log('API Key present:', !!process.env.OPENAI_API_KEY)
    console.log('API Key prefix:', process.env.OPENAI_API_KEY?.substring(0, 10))
    
    const testPrompt = `Extract insights from this text: "Active men can maintain nitrogen balance with 0.8 grams of protein per kilogram of body weight. This finding was used to establish the RDA for protein."`
    
    console.log('Calling OpenAI with model: gpt-5-mini')
    
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        { 
          role: 'system', 
          content: 'You are a helpful assistant that extracts medical insights. Return JSON with format: {"insights": [{"statement": "...", "evidence_type": "ExpertOpinion", "confidence": "high"}]}' 
        },
        { role: 'user', content: testPrompt }
      ],
      // Note: gpt-5-mini only supports default temperature (1), custom values are not supported
      response_format: { type: 'json_object' }
    })
    
    console.log('OpenAI API call completed')
    console.log('Response:', JSON.stringify(completion, null, 2))
    
    const content = completion.choices[0]?.message?.content
    if (!content) {
      return NextResponse.json({ 
        error: 'No content in response',
        completion 
      }, { status: 500 })
    }
    
    console.log('Response content:', content)
    
    const parsed = JSON.parse(content)
    
    return NextResponse.json({
      success: true,
      model: 'gpt-5-mini',
      responseLength: content.length,
      parsed,
      insightsCount: parsed.insights?.length || 0
    })
  } catch (error) {
    console.error('OpenAI test error:', error)
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      details: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : error
    }, { status: 500 })
  }
}
