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

  const prompt = `You are the STRICT official AI judge for the Amrut Durgotsav (दुर्गोत्सव) — an authentic Maratha FORT (किल्ला) making competition.
 
⚠️ ABSOLUTE DISQUALIFICATION RULE — MOSQUE / MASJID / DARGAH / TEMPLE (मशीद / दर्गा / मंदिर):
Examine the physical structure in the photo very carefully:
Does the structure contain ANY elements of a Mosque (मशीद), Dargah (दर्गा), Mausoleum, Tomb, or Temple (मंदिर)?
Look specifically for:
  - Domes (घुमट / कंदुरी घुमट) with or without crescent (चंद्रकोर)
  - Minarets (मिनार) or minaret-like spires
  - Islamic arched gateways (मेहराब / कमान)
  - Urdu, Arabic, or Perso-Arabic name tags / calligraphy (e.g. मेहराब, हुजरा)
  - Religious monument architecture (e.g. Taj Mahal, Dargah, Mosque)

⚠️ IMPORTANT EXCEPTION OVERRIDE:
Even if the structure is built with stone walls (तटबंदी), has water/pond/moat around it, has a statue of Chhatrapati Shivaji Maharaj, has a saffron flag (भगवा ध्वज), or has a child standing next to it — IF THE CENTRAL STRUCTURE IS A MOSQUE, MASJID, OR DARGAH, IT IS IMMEDIATELY DISQUALIFIED!
In that case, you MUST set:
  "hasMosqueOrDargahOrTemple": true,
  "isFortSpecifically": false,
  "isValid": false

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ CRITERIA TO ACCEPT (All must be TRUE):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. FORT REPLICA: Must be a genuine handmade replica of a traditional Maratha / Indian hillfort (किल्ला) with authentic fortification walls (तट), bastions (बुरुज), and fort gates. It must NOT be a religious building.
2. PARTICIPANT: A real human person does NOT need to be visible in the photo. The photo can contain only the handmade fort replica. Presence or absence of a person must NOT affect the verification result.
3. AUTHENTIC REAL PHOTO: The image must show a real photograph of a physically constructed 3D handmade fort model.
4. NO MOSQUE / RELIGIOUS STRUCTURE: hasMosqueOrDargahOrTemple MUST BE false.

IMPORTANT:
- A person standing with the fort is optional.
- A child or family standing with the fort is optional.
- A photo containing only the fort is acceptable.
- However, a genuine physical fort replica MUST be clearly visible.
- If no proper fort replica is visible, reject the image.
- Do NOT approve images containing only landscapes,
  mountains, buildings, toys, drawings, or digital illustrations.

Return STRICTLY in JSON format with NO markdown fences:
{
  "hasMosqueOrDargahOrTemple": true or false,
  "hasFort": true or false,
  "hasPerson": true or false,
  "isAuthentic": true or false,
  "isFortSpecifically": true or false,
  "isValid": true or false,
  "reason": "मराठीत संक्षिप्त कारण (उदा. छायाचित्रात मशिदीची/धार्मिक प्रतिकृती दिसत आहे, या स्पर्धेत केवळ पारंपारिक मराठा किल्लाच मान्य आहे.)"
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
            // Hard check: if mosque / dargah / religious monument detected, immediately disqualify
            if (result.hasMosqueOrDargahOrTemple === true) {
              return {
                isValid: false,
                aiUnavailable: false,
                reason: result.reason || "छायाचित्रात मशीद / दर्गा / धार्मिक वास्तूची प्रतिकृती दिसत आहे. या स्पर्धेत केवळ पारंपारिक मराठा किल्ल्याची प्रतिकृतीच ग्राह्य धरली जाईल.",
                details: result,
              };
            }

            const isApproved = Boolean(
              result.isValid &&
              result.hasFort &&
              result.hasPerson &&
              result.isAuthentic &&
              result.isFortSpecifically &&
              !result.hasMosqueOrDargahOrTemple
            );

            return {
              isValid: isApproved,
              aiUnavailable: false,
              reason: result.reason || (isApproved ? "छायाचित्र पडताळणी यशस्वी" : "छायाचित्रात किल्ल्याची प्रतिकृती किंवा व्यक्ती दिसत नाही."),
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