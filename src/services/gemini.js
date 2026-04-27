const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const PARSING_PROMPT = `
You are an AI assistant for SevaSetu, a disaster relief and volunteer coordination platform in India.

A field worker has submitted a report. Extract structured information from it.
The report may be in Hindi, Chhattisgarhi, English, or Hinglish.

Return ONLY a valid JSON object with this exact structure. No explanation, no markdown, no code fences:
{
  "location": "specific area, ward, or address mentioned (string, or null if not mentioned)",
  "problem_type": "one of: food_shortage, flood, medical, shelter, rescue, infrastructure, other",
  "severity": <integer 1-10, where 10 is life-threatening>,
  "people_affected": <integer estimate, or null if not mentioned>,
  "resources_needed": ["list", "of", "resources", "mentioned"],
  "original_language": "hindi | english | hinglish | chhattisgarhi | other",
  "translated_summary": "1-2 sentence English summary of what is needed",
  "urgency_keywords": ["urgent", "words", "found"],
  "confidence": <float 0.0-1.0>
}

If you cannot extract meaningful information, return:
{"error": "Could not parse report", "confidence": 0.0}
`;

async function parseTextReport(text) {
  try {
    const result = await model.generateContent([
      PARSING_PROMPT,
      `Field report: "${text}"`
    ]);

    const responseText = result.response.text().trim();
    const cleaned = responseText.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);

  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error('Gemini returned non-JSON response');
      return { error: 'Parsing failed: invalid response format', confidence: 0 };
    }
    throw error;
  }
}

async function parseVoiceReport(base64AudioData, mimeType) {
  try {
    const audioPart = {
      inlineData: {
        data: base64AudioData,
        mimeType: mimeType,
      },
    };

    const result = await model.generateContent([
      PARSING_PROMPT,
      'The following is a voice note from a field worker. Transcribe it then extract structured information:',
      audioPart,
    ]);

    const responseText = result.response.text().trim();
    const cleaned = responseText.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);

  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error('Gemini returned non-JSON response for audio');
      return { error: 'Audio parsing failed', confidence: 0 };
    }
    throw error;
  }
}

function calculatePriorityScore(parsedReport) {
  const { severity = 5, people_affected = 0, urgency_keywords = [] } = parsedReport;

  const peopleScore = Math.min(people_affected || 0, 1000) / 100;

  const urgentWords = ['urgent', 'emergency', 'help', 'rescue', 'trapped', 'dying',
                       'phaas', 'bachao', 'madat', 'aapda', 'khatre'];
  const urgencyBonus = Math.min(
    urgency_keywords.filter(k =>
      urgentWords.some(u => k.toLowerCase().includes(u))
    ).length * 2,
    10
  );

  const score = (severity * 0.4) + (Math.min(peopleScore, 10) * 0.3) + (urgencyBonus * 0.3);
  return Math.round(Math.min(score, 10) * 10) / 10;
}

module.exports = { parseTextReport, parseVoiceReport, calculatePriorityScore };