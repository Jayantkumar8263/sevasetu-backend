const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const PARSING_PROMPT = `
You are an AI assistant for RozgarBot, a platform that connects daily wage workers with local job opportunities in India.

A worker has sent a message describing themselves or a job seeker has described what they need.
The message may be in Hindi, Chhattisgarhi, English, or Hinglish.

Return ONLY a valid JSON object with this exact structure. No explanation, no markdown, no code fences:
{
  "role": "worker | employer",
  "skills": ["plumber", "painter", "electrician", "carpenter", "mason", "cleaner", "driver", "helper", "other"],
  "location": "city, area, or neighbourhood mentioned (string, or null if not mentioned)",
  "experience_years": <integer or null if not mentioned>,
  "availability": "immediate | this_week | flexible | null",
  "wage_expectation": "daily wage amount mentioned in INR, or null",
  "job_description": "what work is needed (for employer) or what work can be done (for worker)",
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
        `Worker/Employer message: "${text}"`
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
  // For RozgarBot, score = how complete the profile is (0-10)
  let score = 0;
  if (parsedReport.skills?.length > 0) score += 3;
  if (parsedReport.location) score += 3;
  if (parsedReport.experience_years) score += 2;
  if (parsedReport.availability && parsedReport.availability !== 'null') score += 1;
  if (parsedReport.wage_expectation) score += 1;
  return score;
}

module.exports = { parseTextReport, parseVoiceReport, calculatePriorityScore };