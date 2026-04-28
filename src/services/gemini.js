const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const PARSING_PROMPT = `
You are an AI assistant for RozgarBot, a platform that connects daily wage workers with local job opportunities in India.

A user has sent a message. They are either:
- A CUSTOMER who needs work done at their home/office
- A WORKER who is looking for jobs

The message may be in Hindi, Chhattisgarhi, English, or Hinglish.

Return ONLY a valid JSON object with this exact structure. No explanation, no markdown, no code fences:
{
  "role": "worker | customer | unknown",
  "skills": ["skill1", "skill2"],
  "location": "city, area, or neighbourhood mentioned (string, or null if not mentioned)",
  "city": "just the city name in lowercase (raipur, bhopal, etc.) or null",
  "experience_years": <integer or null if not mentioned>,
  "availability": "immediate | this_week | flexible | null",
  "wage_expectation": "daily wage amount in INR or null",
  "job_description": "what work is needed or what work can be done (1 sentence)",
  "original_language": "hindi | english | hinglish | chhattisgarhi | other",
  "translated_summary": "1-2 sentence English summary",
  "confidence": <float 0.0-1.0>
}

If you cannot extract meaningful information, return:
{"error": "Could not parse message", "confidence": 0.0}
`;

async function parseTextReport(text, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await model.generateContent([
        PARSING_PROMPT,
        `User message: "${text}"`
      ]);

      const responseText = result.response.text().trim();
      const cleaned = responseText.replace(/```json|```/g, '').trim();
      return JSON.parse(cleaned);

    } catch (error) {
      const retryInfo = error?.errorDetails?.find(
        d => d['@type']?.includes('RetryInfo')
      );
      const retryDelay = retryInfo?.retryDelay;
      const delayMs = retryDelay
        ? parseInt(retryDelay) * 1000
        : attempt * 5000;

      if (attempt < retries && error.status === 429) {
        console.log(`Gemini rate limited. Retrying in ${delayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      if (error instanceof SyntaxError) {
        console.error('Gemini returned non-JSON response');
        return { error: 'Parsing failed: invalid response format', confidence: 0 };
      }

      throw error;
    }
  }
}

async function parseVoiceReport(base64AudioData, mimeType, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const audioPart = {
        inlineData: {
          data: base64AudioData,
          mimeType: mimeType,
        },
      };

      const result = await model.generateContent([
        PARSING_PROMPT,
        'The following is a voice note. Transcribe it then extract structured information:',
        audioPart,
      ]);

      const responseText = result.response.text().trim();
      const cleaned = responseText.replace(/```json|```/g, '').trim();
      return JSON.parse(cleaned);

    } catch (error) {
      const retryInfo = error?.errorDetails?.find(
        d => d['@type']?.includes('RetryInfo')
      );
      const retryDelay = retryInfo?.retryDelay;
      const delayMs = retryDelay
        ? parseInt(retryDelay) * 1000
        : attempt * 5000;

      if (attempt < retries && error.status === 429) {
        console.log(`Gemini rate limited. Retrying in ${delayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      if (error instanceof SyntaxError) {
        console.error('Gemini returned non-JSON response for audio');
        return { error: 'Audio parsing failed', confidence: 0 };
      }

      throw error;
    }
  }
}

function calculatePriorityScore(parsedReport) {
  let score = 0;
  if (parsedReport.skills?.length > 0) score += 3;
  if (parsedReport.location) score += 3;
  if (parsedReport.experience_years) score += 2;
  if (parsedReport.availability && parsedReport.availability !== 'null') score += 1;
  if (parsedReport.wage_expectation) score += 1;
  return score;
}

module.exports = { parseTextReport, parseVoiceReport, calculatePriorityScore };