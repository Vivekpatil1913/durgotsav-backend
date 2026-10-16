-- Amrut Durgotsav 2026 — migration 016
-- English versions of the admin-managed अमृत शिवदुर्ग भूषण पुरस्कार content, so the website can follow the
-- language switch. Additive only: new nullable columns + English text for the seeded 2026 edition.

ALTER TABLE award_editions
  ADD COLUMN content_en            JSONB        NOT NULL DEFAULT '{}',
  ADD COLUMN prize_individual_en   VARCHAR(300),
  ADD COLUMN prize_organization_en VARCHAR(300),
  ADD COLUMN closed_note_en        VARCHAR(600);

ALTER TABLE award_winners
  ADD COLUMN name_en        VARCHAR(250),
  ADD COLUMN description_en TEXT;

ALTER TABLE award_committee_members
  ADD COLUMN name_en        VARCHAR(160),
  ADD COLUMN designation_en VARCHAR(300);

UPDATE award_editions SET
  prize_individual_en   = '₹51,000 cash + certificate of honour + memento',
  prize_organization_en = '₹51,000 cash + certificate of honour + memento',
  closed_note_en        = 'The nomination period has ended. Details of the selection process will be announced soon.',
  content_en = '{
    "intro": "The forts that witnessed Chhatrapati Shivaji Maharaj''s Swarajya are Maharashtra''s priceless heritage. The Maharashtra Research, Upliftment and Training Academy (AMRUT) presents the ‘Amrut Shivdurg Bhushan Puraskar’ to recognise and honour individuals and organisations who work selflessly for the history, research, documentation, preservation, conservation and public awareness of these forts.",
    "objectives": [
      "To honour those who work for the conservation, protection and cleanliness of forts.",
      "To encourage research and documentation of the history of forts.",
      "To promote awareness about forts through writing, photography and the media.",
      "To increase the participation of youth, students and volunteers in heritage conservation."
    ],
    "eligibility": [
      "A person doing remarkable work for forts can be nominated in the ‘Individual category’.",
      "A registered or unregistered organisation working for forts can be nominated in the ‘Organization category’.",
      "Nominations may be made by the nominee or by any other person; the nominator''s name and contact number are required.",
      "Evidence of the work (documents, photographs, links) must be available for verification."
    ],
    "instructions": [
      "Choose the nomination type (Individual / Organization). Fill one application per nominee.",
      "Fields marked with an asterisk (*) are mandatory.",
      "Upload evidence of the work as PDF, JPG or PNG files, or provide the relevant links.",
      "Check all details on the ‘Review’ step before submitting. The application cannot be changed after submission.",
      "Keep the reference number you receive after submission."
    ],
    "documents": [
      "Registration certificate of the organisation (Organization category, if applicable)",
      "Documents and reports related to the work",
      "Photographs / videos",
      "Newspaper cuttings, articles, books",
      "Awards and certificates received",
      "Links to documentaries, websites and social media"
    ],
    "process": [
      "Online nomination",
      "Scrutiny of applications",
      "Review and selection by the committee",
      "Award announcement and presentation"
    ],
    "faqs": [
      {"q": "Can I nominate more than one person or organisation?", "a": "Yes. Fill a separate application for each nominee."},
      {"q": "Can the application be changed after submission?", "a": "No. Check all details carefully on the review step before submitting."},
      {"q": "Which documents can be uploaded?", "a": "PDF, JPG and PNG files can be uploaded. For long videos, please provide a YouTube / Drive link."},
      {"q": "Whose decision is final for the selection?", "a": "The decision of AMRUT / the selection committee regarding the selection process will be final."}
    ],
    "help": "If you face any difficulty with the nomination, please contact us at the email or helpline given on the Contact page."
  }'
WHERE year = 2026;

-- The seeded descriptions only repeated the category name; the page already shows the category
UPDATE award_winners SET description = NULL WHERE description IN ('व्यक्तिगत विभाग', 'संस्थात्मक विभाग');
UPDATE award_winners SET name_en = 'Shri P. K. Ghanekar' WHERE name = 'श्री. प्र. के. घाणेकर' AND name_en IS NULL;
UPDATE award_winners SET name_en = 'Sahyadri Pratishthan' WHERE name = 'सह्याद्री प्रतिष्ठान' AND name_en IS NULL;
