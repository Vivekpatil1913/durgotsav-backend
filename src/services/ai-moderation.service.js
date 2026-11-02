
import sharp from "sharp";
import { logger } from "../utils/logger.js";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash";

const MODERATION_PROMPT = `
You are an image moderation system for Amrut Durgotsav,
a traditional Indian fort-making competition.

Perform THREE INDEPENDENT VERIFICATION CHECKS.

CHECK 1: FORT DETECTION

Identify whether the image clearly contains a physical
3D handmade traditional Indian / Maratha fort replica.

ACCEPTABLE FORT FEATURES:
- Fortification walls (तट)
- Bastions (बुरुज)
- Fort gates (दरवाजा)
- Towers and defensive structures
- Hill fort miniature models
- Handmade Diwali forts
- Models made using mud, soil, stones, bricks,
  cardboard, clay, thermocol or similar materials.

A fort replica can be large or small.
It can be created at home, school or outdoors.

CHECK 2: PARTICIPANT DETECTION

Check whether at least one real person is clearly
visible along with the fort replica.

Accept:
- Individual photos with a fort.
- Group photos with a fort.
- Children with a fort.
- Adults with a fort.

The person does not need to stand immediately
next to the fort, but must be visible in the photo.

CHECK 3: IMAGE AUTHENTICITY AND UNRELATED OBJECTS

Determine whether this appears to be a real camera
photograph of a physical fort model.

AI-GENERATED IMAGE:
- If there is strong visual evidence that the image
  is AI-generated or digitally fabricated, mark it
  as AI_SUSPECTED.
- If uncertain, mark it as UNCERTAIN.
- Do not claim AI detection with 100% certainty.
- Normal image editing, compression or filters alone
  do not prove AI generation.

UNRELATED IMAGES:
Identify images showing:
- Mosque / Masjid
- Temple without a fort replica
- Normal buildings
- Houses
- Farms / agricultural fields
- Roads and vehicles
- Gardens and landscapes
- Waterfalls, rivers and mountains
- Animals
- Selfies without a visible fort
- Other unrelated objects or activities.

IMPORTANT:
A building, wall or boundary alone is NOT a fort.
A temple or mosque is NOT a fort.
A real fort replica must be clearly identifiable.

FINAL DECISION RULES:

APPROVED:
Only when ALL conditions are true:
1. A clear physical handmade fort replica exists.
2. At least one real participant is visible.
3. Image appears to be a genuine photograph.
4. No strong evidence of AI generation.

PENDING:
Use PENDING for ALL other cases:
- AI-generated or AI-suspected photos.
- Mosque, temple, house, building or farm.
- Other unrelated images.
- Fort without a visible participant.
- Unclear or ambiguous photos.
- Uncertain authenticity.

NEVER automatically reject an image.
All non-approved images must go to manual admin review.

Return ONLY valid JSON:

{
  "hasFort": true,
  "hasPerson": true,
  "isAuthentic": true,
  "isAIGenerated": false,
  "fortType": "MODEL_FORT",
  "category": "FORT_WITH_PARTICIPANT",
  "confidence": 0.98,
  "status": "APPROVED",
  "reason": "मराठीत संक्षिप्त कारण"
}

Allowed values:
fortType: MODEL_FORT, NONE, UNCERTAIN
category:
FORT_WITH_PARTICIPANT,
AI_GENERATED_SUSPECTED,
MOSQUE,
TEMPLE,
BUILDING,
HOUSE,
FARM,
OTHER,
UNCERTAIN

isAuthentic:
true, false, null

status:
APPROVED, PENDING

Return JSON only. No markdown.
`;

function parseAIResponse(text) {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1) {
    throw new Error("Invalid Gemini JSON response");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

function pendingResult(reason, details = null) {
  return {
    isValid: false,
    status: "PENDING",
    aiUnavailable: false,
    reason,
    details,
  };
}

export async function verifyParticipantPhotoWithAI(imageBuffer) {
  try {
    const jpegBuffer = await sharp(imageBuffer)
      .rotate()
      .resize(768, 768, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer();

    const base64Image = jpegBuffer.toString("base64");

    const geminiKey = process.env.GEMINI_API_KEY;

    if (!geminiKey) {
      return {
        isValid: false,
        status: "PENDING",
        aiUnavailable: true,
        reason: "Gemini API key उपलब्ध नाही. Admin review आवश्यक आहे.",
      };
    }

    const geminiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`;

    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: MODERATION_PROMPT },
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
          temperature: 0,
          response_mime_type: "application/json",
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error?.message || `Gemini API error: ${response.status}`
      );
    }

    const aiText =
      data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("") || "";

    if (!aiText) {
      throw new Error("Empty Gemini response");
    }

    const result = parseAIResponse(aiText);

    // Validate all required fields.
    const validFort =
      result.hasFort === true &&
      result.fortType === "MODEL_FORT";

    const validPerson = result.hasPerson === true;

    const genuinePhoto =
      result.isAuthentic === true &&
      result.isAIGenerated === false;

    // APPROVED only when every condition passes.
    const isApproved =
      validFort &&
      validPerson &&
      genuinePhoto &&
      result.status === "APPROVED";

    const finalResult = {
      isValid: isApproved,
      status: isApproved ? "APPROVED" : "PENDING",
      aiUnavailable: false,
      reason:
        result.reason ||
        "छायाचित्र प्रशासकीय तपासणीसाठी पाठवले आहे.",
      details: result,
    };

    logger.info(
      {
        aiModel: GEMINI_MODEL,
        aiResult: finalResult,
      },
      "Fort photo verification completed"
    );

    return finalResult;

  } catch (error) {
    logger.error(
      { error: error.message },
      "Gemini photo verification failed"
    );

    // API failure must never approve a photo.
    return {
      isValid: false,
      status: "PENDING",
      aiUnavailable: true,
      reason:
        "AI पडताळणी सध्या उपलब्ध नाही. फोटो Admin Review साठी पाठवला आहे.",
    };
  }
}
