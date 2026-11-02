import sharp from "sharp";
import { logger } from "../utils/logger.js";

/**
 * Analyzes participant fort photo using Gemini Vision models.
 * Returns:
 * { isValid: true, aiUnavailable: false, reason, details } → AI approved
 * { isValid: false, aiUnavailable: false, reason, details } → AI rejected (bad photo)
 * { isValid: false, aiUnavailable: true, reason } → AI unreachable; fallback to manual admin review (original flow)
 */
export async function verifyParticipantPhotoWithAI(imageBuffer) {
// Convert image to optimized lightweight JPEG for rapid AI processing
 const jpegBuffer = await sharp(imageBuffer)
 .resize(600, 600, { fit: "inside", withoutEnlargement: true })
 .jpeg({ quality: 70 })
 .toBuffer();

 const base64Image = jpegBuffer.toString("base64");

 const prompt = `You are the STRICT official AI judge for the Amrut Durgotsav (दुर्गोत्सव) — a FORT (किल्ला) making competition.

🎯 YOUR ONLY JOB: Check if this photo meets ALL 3 required criteria below.
If ANY ONE criteria fails → isValid = false. No exceptions. No second chances.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ CRITERIA TO ACCEPT (All 3 must be TRUE):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITERIA 1 — FORT REPLICA (किल्ल्याची प्रतिकृती):
The photo MUST show a handmade physical replica of a traditional Maratha / Indian hillfort (किल्ला).
The fort MUST clearly have:
 - Fortification walls (तट) or bastions (बुरुज)
 - A fort gate (दरवाजा) or towers
 - Overall structure of a hilltop fort
hasFort = true and isFortSpecifically = true ONLY for this.

CRITERIA 2 — PARTICIPANT (सहभागी व्यक्ती):
A real human person (child or adult) must be clearly and visibly present in the photo along with the fort replica.
hasPerson = true only if a real person is visible standing with the fort.

CRITERIA 3 — AUTHENTIC REAL PHOTO (मूळ छायाचित्र):
Must be a real camera photograph of a physical 3D object.
isAuthentic = true only for this.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ REJECT EVERYTHING ELSE (isValid = false):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If the image does NOT match ALL 3 criteria above, REJECT it.
This includes but is not limited to: mosque, masjid, temple, Taj Mahal, church, palace, garden, pond, road, vehicle, selfie, animals, food, nature, sky, landscape, screenshot, meme, cartoon, printed photo, random objects, or anything that is NOT a traditional Maratha fort replica with a person.

Return STRICTLY in JSON format with NO markdown fences:
{
 "isValid": true or false,
 "hasFort": true or false,
 "hasPerson": true or false,
 "isAuthentic": true or false,
 "isFortSpecifically": true or false,
 "reason": "मराठीत संक्षिप्त कारण"
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