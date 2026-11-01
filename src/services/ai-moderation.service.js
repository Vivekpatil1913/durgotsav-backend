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

  const prompt = `You are the STRICT official AI judge for the Amrut Durgotsav (दुर्गोत्सव) — a FORT (किल्ला) making competition. This competition is ONLY about handmade replicas of traditional Maratha / Indian hillforts (किल्ला). 

⚠️ CRITICAL RULES — READ CAREFULLY:

RULE 1 — MUST BE A FORT (किल्ला) SPECIFICALLY:
The image MUST show a handmade replica of a traditional Maratha or Indian HILLFORT (किल्ला) with fort-like features such as:
  - Fortification walls (तट / बुरुज)
  - Watchtowers or bastions
  - Fort gates (दरवाजा)
  - Battlements or ramparts
  - Typical hilltop fort layout
hasFort = true ONLY if it is clearly a FORT (किल्ला). 

❌ REJECT IMMEDIATELY (hasFort = false, isFortSpecifically = false) if the image shows ANY of these:
  - Mosque / Masjid (मशीद) — domes (घुमट), minarets (मिनार), arched entrances
  - Temple (मंदिर) or any religious building
  - Taj Mahal or other monument replica
  - Church, palace, or modern building
  - Garden decoration, water fountain, or pond feature
  - Road, street, footpath, vehicle, or outdoor scene
  - Selfie or portrait (person only, no fort)
  - Animals, birds, food, plants, trees, or nature photos
  - Sky, sunset, landscape, or travel photos
  - Screenshot, meme, cartoon, drawing, or printed photo
  - Random objects: books, toys, bags, household items
  - Any image where the MAIN subject is NOT a traditional Maratha hillfort replica

RULE 2 — PARTICIPANT PRESENT:
A real person (child or adult) must be clearly visible in the photo standing with the fort replica.

RULE 3 — AUTHENTIC PHOTO:
Must be a real photograph. Reject documents, papers, signatures, wallpapers, AI-generated or digital images.

Return your decision STRICTLY in JSON format with NO markdown fences:
{
  "isValid": true or false,
  "hasFort": true or false,
  "hasPerson": true or false,
  "isAuthentic": true or false,
  "isFortSpecifically": true or false,
  "reason": "मराठीत संक्षिप्त कारण (उदा. छायाचित्रात मशिदीची प्रतिकृती आहे, किल्ल्याची नाही. या स्पर्धेत फक्त किल्ल्याची प्रतिकृती मान्य आहे.)"
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
              isValid: Boolean(result.isValid && result.hasFort && result.hasPerson && result.isAuthentic && result.isFortSpecifically),
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
