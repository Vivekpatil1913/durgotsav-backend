import sharp from "sharp";
import { logger } from "../utils/logger.js";

/**
 * Analyzes participant fort photo using Gemini Vision models.
 * Returns:
 *   { isValid: true,  aiUnavailable: false, reason, details }   → AI approved
 *   { isValid: false, aiUnavailable: false, reason, details }   → AI rejected (bad photo)
 *   { isValid: false, aiUnavailable: true,  reason }            → AI unreachable; fallback to manual admin review (original flow)
 */
export async function verifyParticipantPhotoWithAI(imageBuffer) {
  // Convert image to optimized lightweight JPEG for rapid AI processing
  const jpegBuffer = await sharp(imageBuffer)
    .resize(600, 600, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();

  const base64Image = jpegBuffer.toString("base64");

  const prompt = `You are the strict official AI judge for the Amrut Durgotsav (दुर्गोत्सव) fort making competition.
Examine this submitted image carefully and verify the following 3 strict rules:
1. FORT REPLICA (किल्ल्याची प्रतिकृती): Does the image clearly contain a handmade mud, clay, or stone fort replica?
2. PARTICIPANT (सहभागी व्यक्ती): Is a real person, child, or group of participants clearly present in the photo with the fort?
3. AUTHENTICITY (मूळ छायाचित्र): Is this an authentic real camera photograph? (It must NOT be a signature, document, paper, selfie without a fort, stock wallpaper, 3D render, digital art, or AI-generated image).

IF the image is a paper, handwriting, signature, plain document, selfie without a handmade fort, or random object, IT MUST BE REJECTED with isValid: false.

Return your decision strictly in JSON format with NO markdown fences:
{
  "isValid": true or false,
  "hasFort": true or false,
  "hasPerson": true or false,
  "isAuthentic": true or false,
  "reason": "मराठीत संक्षिप्त कारण (उदा. छायाचित्रात किल्ल्याची प्रतिकृती आणि व्यक्ती दिसत नाही. कृपया किल्ल्यासोबतचा स्वतःचा मूळ फोटो अपलोड करा.)"
}`;

  // Try Gemini Vision models (fast & reliable)
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    const candidateModels = ["gemini-flash-lite-latest", "gemini-3.5-flash"];
    for (const model of candidateModels) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
        const res = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inline_data: {
                      mime_type: "image/jpeg",
                      data: base64Image,
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.1,
              response_mime_type: "application/json",
            },
          }),
        });

        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const match = text.match(/\{[\s\S]*\}/);
          if (match) {
            const result = JSON.parse(match[0]);
            logger.info({ aiModel: model, aiResult: result }, "AI moderation completed via Gemini Vision");
            return {
              isValid: Boolean(result.isValid && result.hasFort && result.hasPerson && result.isAuthentic),
              aiUnavailable: false,
              reason: result.reason || (result.isValid ? "छायाचित्र पडताळणी यशस्वी" : "छायाचित्रात किल्ल्याची प्रतिकृती किंवा व्यक्ती दिसत नाही."),
              details: result,
            };
          }
        } else if (data.error) {
          logger.warn({ model, error: data.error.message || data.error }, "Gemini model error, trying next fallback");
        }
      } catch (err) {
        logger.warn({ model, err: err.message }, "Gemini model attempt failed, trying next fallback");
      }
    }
  }

  // Gemini unreachable or failed → fallback directly to manual admin review (original flow)
  logger.warn("Gemini AI unavailable or failed. Registration will fallback to manual admin review.");
  return {
    isValid: false,
    aiUnavailable: true,
    reason: "AI पडताळणी सेवा उपलब्ध नाही. नोंदणी प्रशासकाच्या तपासणीसाठी पाठवली जाईल.",
  };
}
