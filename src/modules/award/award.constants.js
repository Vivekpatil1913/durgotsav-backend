// Option lists for the शिवदुर्ग भूषण पुरस्कार forms. The API is the single source:
// the website and admin read these from GET /api/shivdurg-award (`options`), exports use the labels.

export const CATEGORIES = {
  individual:   { mr: "व्यक्तिगत विभाग", en: "Individual" },
  organization: { mr: "संस्थात्मक विभाग", en: "Organization" },
};

// Workflow (Developer Requirements §14). Draft is not offered: save-as-draft is not an approved requirement yet.
export const STATUSES = {
  submitted:    { mr: "सादर", en: "Submitted" },
  under_review: { mr: "छाननी सुरू", en: "Under Review" },
  shortlisted:  { mr: "निवड यादीत", en: "Shortlisted" },
  selected:     { mr: "निवड", en: "Selected" },
  not_selected: { mr: "निवड नाही", en: "Not Selected" },
};

// Allowed moves. Backward moves let the committee correct a mistake; every move is recorded in history.
export const TRANSITIONS = {
  submitted:    ["under_review", "not_selected"],
  under_review: ["shortlisted", "not_selected", "submitted"],
  shortlisted:  ["selected", "not_selected", "under_review"],
  selected:     ["shortlisted"],
  not_selected: ["under_review"],
};

export const INDIVIDUAL_WORK = {
  conservation:          { mr: "गड-दुर्ग संवर्धन", en: "Fort conservation" },
  research:              { mr: "गड-दुर्ग संशोधन", en: "Fort research" },
  history_documentation: { mr: "गड-दुर्ग इतिहास व दस्तऐवजीकरण", en: "History & documentation" },
  awareness:             { mr: "गड-दुर्ग जनजागृती", en: "Public awareness" },
  trekking_guidance:     { mr: "गड-दुर्ग भ्रमंती / मार्गदर्शन", en: "Trekking / guidance" },
  writing_publication:   { mr: "गड-दुर्ग विषयक लेखन / प्रकाशन", en: "Writing / publication" },
  photography_film:      { mr: "गड-दुर्ग छायाचित्रण / चित्रफिती निर्मिती", en: "Photography / film-making" },
  volunteering:          { mr: "गड-दुर्ग संवर्धनासाठी स्वयंसेवी कार्य", en: "Volunteer conservation work" },
  other:                 { mr: "इतर कार्य", en: "Other work" },
};

export const ORGANIZATION_WORK = {
  conservation:            { mr: "गड-दुर्ग संवर्धन", en: "Fort conservation" },
  protection:              { mr: "गड-दुर्ग संरक्षण", en: "Fort protection" },
  historical_research:     { mr: "ऐतिहासिक संशोधन", en: "Historical research" },
  documentation:           { mr: "गड-दुर्ग दस्तऐवजीकरण", en: "Fort documentation" },
  cleanliness_maintenance: { mr: "गड-दुर्ग स्वच्छता व देखभाल", en: "Cleanliness & maintenance" },
  heritage_conservation:   { mr: "ऐतिहासिक वारसा संवर्धन", en: "Heritage conservation" },
  awareness:               { mr: "गड-दुर्ग विषयक जनजागृती", en: "Public awareness" },
  trekking_guidance:       { mr: "गड-दुर्ग भ्रमंती व मार्गदर्शन", en: "Trekking & guidance" },
  youth_participation:     { mr: "युवक / विद्यार्थी सहभाग", en: "Youth / student participation" },
  writing_publication:     { mr: "गड-दुर्ग विषयक लेखन / प्रकाशन", en: "Writing / publication" },
  photography_documentary: { mr: "छायाचित्रण / चित्रफिती / माहितीपट निर्मिती", en: "Photography / films / documentaries" },
  other:                   { mr: "इतर", en: "Other" },
};

export const ORG_TYPES = {
  public_trust:       { mr: "सार्वजनिक न्यास", en: "Public trust" },
  registered_society: { mr: "नोंदणीकृत संस्था", en: "Registered institution" },
  society:            { mr: "सोसायटी", en: "Society" },
  company:            { mr: "कंपनी", en: "Company" },
  ngo:                { mr: "स्वयंसेवी संस्था", en: "Voluntary organisation (NGO)" },
  other:              { mr: "इतर", en: "Other" },
};

// Registration number / date / authority are mandatory for these types (formally registered bodies).
// Voluntary groups and "other" may be unregistered, so the fields stay optional for them.
export const ORG_TYPES_REQUIRING_REGISTRATION = ["public_trust", "registered_society", "society", "company"];

export const RESEARCH_TOOLS = {
  manuscripts:     { mr: "हस्तलिखिते / ऐतिहासिक कागदपत्रे", en: "Manuscripts / historical records" },
  maps:            { mr: "नकाशे / आराखडे", en: "Maps / plans" },
  photographs:     { mr: "छायाचित्रे", en: "Photographs" },
  videos:          { mr: "चित्रफिती / माहितीपट", en: "Videos / documentaries" },
  surveys:         { mr: "प्रत्यक्ष सर्वेक्षण नोंदी", en: "Field survey records" },
  library:         { mr: "ग्रंथालय / संदर्भ ग्रंथ", en: "Library / reference books" },
  digital_archive: { mr: "डिजिटल संग्रह / संकेतस्थळ", en: "Digital archive / website" },
  other:           { mr: "इतर", en: "Other" },
};

export const DOCUMENT_TYPES = {
  registration_certificate: { mr: "नोंदणी प्रमाणपत्र", en: "Registration certificate" },
  work_document:            { mr: "कार्याशी संबंधित कागदपत्र", en: "Supporting work document" },
  photograph:               { mr: "छायाचित्र", en: "Photograph" },
  video:                    { mr: "चित्रफीत", en: "Video" },
  newspaper:                { mr: "वृत्तपत्र कात्रण", en: "Newspaper cutting" },
  research_report:          { mr: "संशोधन अहवाल", en: "Research report" },
  publication:              { mr: "प्रकाशित पुस्तक / लेख", en: "Published book / article" },
  award_certificate:        { mr: "पुरस्कार / प्रमाणपत्र", en: "Award / certificate" },
  documentary_link:         { mr: "माहितीपट लिंक", en: "Documentary link" },
  web_social_link:          { mr: "संकेतस्थळ / समाजमाध्यम लिंक", en: "Website / social media link" },
  other:                    { mr: "इतर पुरावा", en: "Other evidence" },
};

// Accepted evidence files: extension → { mime types the browser may report, signature check }
export const FILE_TYPES = {
  pdf:  { mimes: ["application/pdf"], kind: "pdf" },
  jpg:  { mimes: ["image/jpeg", "image/pjpeg"], kind: "jpeg" },
  jpeg: { mimes: ["image/jpeg", "image/pjpeg"], kind: "jpeg" },
  png:  { mimes: ["image/png"], kind: "png" },
};
export const VIDEO_FILE_TYPES = {
  mp4:  { mimes: ["video/mp4"], kind: "mp4" },
  webm: { mimes: ["video/webm"], kind: "webm" },
};

export const STORED_MIME = { pdf: "application/pdf", jpeg: "image/jpeg", png: "image/png", mp4: "video/mp4", webm: "video/webm" };

const asOptions = (map) => Object.entries(map).map(([value, l]) => ({ value, ...l }));

export const publicOptions = () => ({
  categories: asOptions(CATEGORIES),
  statuses: asOptions(STATUSES),
  individual_work: asOptions(INDIVIDUAL_WORK),
  organization_work: asOptions(ORGANIZATION_WORK),
  org_types: asOptions(ORG_TYPES),
  org_types_requiring_registration: ORG_TYPES_REQUIRING_REGISTRATION,
  research_tools: asOptions(RESEARCH_TOOLS),
  document_types: asOptions(DOCUMENT_TYPES),
});

export const workLabel = (category, key) =>
  (category === "organization" ? ORGANIZATION_WORK : INDIVIDUAL_WORK)[key]?.mr ?? key;
