-- Amrut Durgotsav 2026 — migration 040
-- The photo a participant uploads is now "a selfie with the fort replica or a photograph of the fort replica": the
-- participant no longer has to be in the photo, only the replica has to be clearly visible. The rules (Marathi and
-- English), the FAQ, the timeline and the announcement were seeded with the older wording, and the seeders never touch
-- rows that already exist. Only the seeded sentences are replaced; a text an admin wrote differently is kept as it is.
UPDATE pages
SET body = replace(replace(replace(body,
      'तयार केलेल्या दुर्गाच्या प्रतिकृतीसोबत छायाचित्र (Selfie/Photograph) काढून',
      'तयार केलेल्या दुर्गाच्या प्रतिकृतीसोबत सेल्फी किंवा दुर्गाच्या प्रतिकृतीचे छायाचित्र काढून'),
      'तयार केलेल्या दुर्गाच्या प्रतिकृतीसोबत स्वतःचे छायाचित्र (Selfie/Photograph) काढून',
      'तयार केलेल्या दुर्गाच्या प्रतिकृतीसोबत सेल्फी किंवा दुर्गाच्या प्रतिकृतीचे छायाचित्र काढून'),
      'छायाचित्रामध्ये सहभागी व्यक्ती आणि तयार केलेली दुर्गाची प्रतिकृती शक्यतो स्पष्टपणे दिसणे आवश्यक राहील.',
      'छायाचित्रामध्ये तयार केलेली दुर्गाची प्रतिकृती स्पष्टपणे दिसणे आवश्यक राहील; सेल्फीमध्ये सहभागी व्यक्तीही स्पष्टपणे दिसावी.'),
    body_en = replace(replace(replace(body_en,
      'Participants should take a selfie or photograph alongside their fort replica, upload it',
      'Participants should take a selfie with their fort replica or a photograph of the fort replica, upload it'),
      'Take a selfie or photograph with your completed fort replica and upload it',
      'Take a selfie with your completed fort replica or a photograph of the fort replica and upload it'),
      'Ideally, both the participant and the fort replica should be clearly visible in the photograph.',
      'The fort replica must be clearly visible in the photograph; in a selfie, the participant should be clearly visible too.')
WHERE slug = 'rules';

UPDATE faqs
SET answer = replace(answer,
      'आपण स्वतः तयार केलेल्या दुर्गाच्या प्रतिकृतीसोबत आपले छायाचित्र (Selfie/Photograph). छायाचित्रात आपण व प्रतिकृती दोन्ही स्पष्ट दिसावेत.',
      'आपण स्वतः तयार केलेल्या दुर्गाच्या प्रतिकृतीसोबतचा सेल्फी किंवा दुर्गाच्या प्रतिकृतीचे छायाचित्र. छायाचित्रात प्रतिकृती स्पष्ट दिसावी; सेल्फीमध्ये आपणही स्पष्ट दिसावेत.')
WHERE answer LIKE '%(Selfie/Photograph)%';

UPDATE events
SET description = replace(description,
      'तिच्यासोबतचे आपले छायाचित्र अपलोड करा',
      'तिच्यासोबतचा सेल्फी किंवा दुर्गाच्या प्रतिकृतीचे छायाचित्र अपलोड करा')
WHERE description LIKE '%तिच्यासोबतचे आपले छायाचित्र अपलोड करा%';

UPDATE announcements
SET body = replace(body,
      'तिच्यासोबत छायाचित्र काढा',
      'तिच्यासोबत सेल्फी किंवा दुर्गाच्या प्रतिकृतीचे छायाचित्र काढा')
WHERE body LIKE '%तिच्यासोबत छायाचित्र काढा%';
