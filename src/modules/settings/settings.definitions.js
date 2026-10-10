import { z } from "zod";

const s = (max) => z.string().trim().max(max);
const iso = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date/time");
const link = z.union([z.literal(""), z.string().trim().url().max(500), z.string().startsWith("/").max(500)]);

// Every setting the site knows about: its validation schema, whether the public site may read it,
// and its initial value (seeded once; edited later in Admin → Settings).
export const SETTINGS = {
  registration: {
    public: true,
    schema: z.object({ enabled: z.boolean(), opens_at: iso, closes_at: iso, note: s(500).optional() }),
    // परिशिष्ट-अ §4. The closing year is printed as २०२७ in the PDF — very likely meant 2026; confirm before launch.
    initial: {
      enabled: true,
      opens_at: "2026-11-05T00:00:00+05:30",
      closes_at: "2027-11-25T23:59:59+05:30",
      note: "दुर्गोत्सवासाठी ऑनलाइन नोंदणी ५ नोव्हेंबर २०२६ पासून सुरू होईल.",
    },
  },
  hero: {
    public: true,
    schema: z.object({ eyebrow: s(120), title: s(120), subtitle: s(600), image: link }),
    initial: {
      eyebrow: "महाराष्ट्राच्या गौरवशाली वारशाचा उत्सव",
      title: "अमृत दुर्गोत्सव २०२६",
      subtitle: "शिवछत्रपतींच्या पराक्रमाचे साक्षीदार राहिलेल्या आपल्या १२ गडदुर्गांना UNESCO कडून वैश्विक ख्यातीच्या वास्तू म्हणून मान्यता महाराष्ट्र सरकारच्या अथक प्रयत्नातून नुकतीच मिळाली.",
      image: "/images/rajgad.webp",
    },
  },
  initiative: {
    public: true,
    schema: z.object({ unesco_title: s(200), gr_reference: s(500), gr_reference_en: s(500).optional() }),
    initial: {
      unesco_title: "Maratha Military Landscapes of India",
      gr_reference: "शासन निर्णय, सांस्कृतिक कार्य विभाग, क्र. संकीर्ण ८२२६/प्र.क्र. ३३० (ई-१७७०३०३)/सां.का. ४, दि. ०३ सप्टेंबर, २०२६",
      gr_reference_en: "Govt. Resolution, Dept. of Cultural Affairs, No. Misc. 8226/Pr.No. 330 (E-17703030)/C.A. 4, dated 03 September 2026",
    },
  },
  world_record: {
    public: true,
    schema: z.object({ enabled: z.boolean(), eyebrow: s(120), title: s(200), body: s(2000), image: link }),
    initial: {
      enabled: true,
      eyebrow: "दुर्गोत्सव २०२५ — विश्वविक्रम गौरव",
      title: "Largest Online Photo Album of Handmade Sculptures",
      body: "आपण सर्वांनी मिळून दुर्गोत्सवाला \"Guinness Book of World Records\" मध्ये स्थान मिळवून दिले. प्रत्येक सहभागी, स्वयंसेवक आणि शुभेच्छुकासाठी हा अभिमानाचा क्षण आहे. दुर्गोत्सव २०२६ मध्ये ही परंपरा अधिक उंचीवर नेऊया!",
      image: "/images/world-record.webp",
    },
  },
  contact: {
    public: true,
    schema: z.object({ email: s(160), phone: s(30), whatsapp: s(20), address: s(500), address_en: s(500).optional(), hours: s(200).optional() }),
    initial: {
      email: "info@mahaamrut.org.in",
      phone: "+91 91122 26154",
      whatsapp: "919112226154",
      address: "महाराष्ट्र संशोधन, उन्नती व प्रशिक्षण प्रबोधिनी (अमृत), महाराज सयाजीराव गायकवाड उद्योग भवन, पाचवा मजला, औंध, पुणे – ४११०६७",
      address_en: "Maharashtra Research, Upliftment and Training Academy (AMRUT), 5th Floor, Maharaj Sayajirao Gaekwad Industrial Estate, Aundh, Pune – 411067",
      hours: "सोमवार – शनिवार, सकाळी १० ते सायं. ६",
    },
  },
  social: {
    public: true,
    schema: z.object({ instagram: link, youtube: link, facebook: link, x: link }),
    initial: { instagram: "https://www.instagram.com/durgotsav2025", youtube: "", facebook: "", x: "" },
  },
  seo: {
    public: true,
    schema: z.object({ site_name: s(120), default_title: s(160), default_description: s(300), og_image: link }),
    initial: {
      site_name: "अमृत दुर्गोत्सव २०२६",
      default_title: "अमृत दुर्गोत्सव २०२६ | चला, दुर्ग बनवूया!",
      default_description: "दिवाळीत दुर्गाची प्रतिकृती बनवा, छायाचित्र अपलोड करा आणि डिजिटल अभिनंदन पत्र मिळवा. शिवछत्रपतींच्या १२ युनेस्को जागतिक वारसा दुर्गांना मानवंदना.",
      og_image: "/og-image.jpg",
    },
  },
};

export const settingsUpdateSchema = z
  .object(Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, d.schema.optional()])))
  .strict();
