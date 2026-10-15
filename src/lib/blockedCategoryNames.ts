/**
 * Store-category names this system refuses to create.
 *
 * Bills payment is not a service offered here — this is a Pabili system, and a
 * rider cannot settle someone's electricity account. A category for it would put
 * an unfulfillable option in front of the customer.
 *
 * Blocking only the English spelling would be close to useless. Tacurong is in
 * Sultan Kudarat, and the ordinary Philippine name for one of these outlets is
 * "Bayad Center" — far likelier to be typed than "Bills & Payment Centers".
 *
 * `bayad` is the shared root for "payment" across Tagalog, Cebuano/Bisaya,
 * Hiligaynon/Ilonggo, Ilokano and Bicolano, so one entry covers most of the
 * region's languages at once.
 *
 * NOTE: the non-English terms want a native speaker's review. `bayad`, `bayarin`,
 * `singil`, `padala` and `sukot` are solid; the Ilokano and Bicolano inflections
 * are less certain, and Ayta/Ita terms are omitted rather than guessed at.
 */

/** Matched as a whole word, so "bayad" does not trip on "Bayambang". */
export const BLOCKED_CATEGORY_TOKENS: ReadonlyArray<{ term: string; language: string }> = [
  { term: "bills", language: "English" },
  { term: "utility", language: "English" },
  { term: "utilities", language: "English" },
  { term: "remittance", language: "English" },
  { term: "remit", language: "English" },

  { term: "bayad", language: "Tagalog / Cebuano / Hiligaynon / Ilokano / Bicolano" },
  { term: "bayarin", language: "Tagalog" },
  { term: "bayaran", language: "Tagalog / Hiligaynon" },
  { term: "bayadan", language: "Ilokano / Bicolano" },
  { term: "bayranan", language: "Cebuano / Bisaya" },
  { term: "bayaranan", language: "Cebuano / Bisaya" },
  { term: "singil", language: "Tagalog / Hiligaynon / Bicolano" },
  { term: "singilin", language: "Tagalog" },
  { term: "singir", language: "Ilokano" },
  { term: "sukot", language: "Cebuano / Hiligaynon" },
  { term: "padala", language: "Tagalog" },

  // Non-Pabili service categories:
  // Schools & Education
  { term: "school", language: "English" },
  { term: "schools", language: "English" },
  { term: "education", language: "English" },
  { term: "educational", language: "English" },
  { term: "institution", language: "English" },
  { term: "institutions", language: "English" },
  { term: "university", language: "English" },
  { term: "college", language: "English" },
  { term: "academy", language: "English" },

  // Banks & Finance
  { term: "bank", language: "English" },
  { term: "banks", language: "English" },
  { term: "atm", language: "English" },

  // Motor trades
  { term: "motorparts", language: "English" },
  { term: "automotive", language: "English" },

  // Logistics & Courier / Express
  { term: "logistics", language: "English" },
  { term: "logistic", language: "English" },
  { term: "logicstics", language: "English (common spelling)" },
  { term: "courier", language: "English" },
  { term: "couriers", language: "English" },
  { term: "freight", language: "English" },
  { term: "cargo", language: "English" },
  { term: "shipping", language: "English" },
  { term: "forwarder", language: "English" },
  { term: "forwarding", language: "English" },
  { term: "express", language: "English" },
  { term: "xpress", language: "English" },

  // Police Outposts & Law Enforcement
  { term: "police", language: "English" },
  { term: "outpost", language: "English" },
  { term: "outposts", language: "English" },
  { term: "precinct", language: "English" },
  { term: "pnp", language: "Philippine National Police" },

  // Government Offices
  { term: "government", language: "English" },
  { term: "governments", language: "English" },
  { term: "govt", language: "English" },
  { term: "office", language: "English" },
  { term: "offices", language: "English" },
  { term: "municipal", language: "English" },
  { term: "capitol", language: "English" },
  { term: "courthouse", language: "English" },
  { term: "embassy", language: "English" },
  { term: "lgu", language: "English" },

  // Network / Telecom / ISP
  { term: "network", language: "English" },
  { term: "networks", language: "English" },
  { term: "networking", language: "English" },
  { term: "telecom", language: "English" },
  { term: "telecommunications", language: "English" },
  { term: "isp", language: "English" },
  { term: "broadband", language: "English" },

  // Internet Cafe / Gaming / Computer Shops
  { term: "internet", language: "English" },
  { term: "cybercafe", language: "English" },
  { term: "netcafe", language: "English" },
  { term: "icafe", language: "English" },
  { term: "pisonet", language: "Tagalog / English" },
  { term: "esports", language: "English" },

  // Nightclubs / Bars / KTV
  { term: "nightclub", language: "English" },
  { term: "nightclubs", language: "English" },
  { term: "disco", language: "English" },
  { term: "discotheque", language: "English" },
  { term: "ktv", language: "English" },
  { term: "beerhouse", language: "English" },
  { term: "restobar", language: "English" },
  { term: "pub", language: "English" },
  { term: "videoke", language: "Tagalog / English" },
  { term: "karaoke", language: "English" },
  { term: "casino", language: "English" },

  // Salons & Personal Care
  { term: "salon", language: "English" },
  { term: "salons", language: "English" },
  { term: "barbershop", language: "English" },
  { term: "barber", language: "English" },
  { term: "spa", language: "English" },

  // Carwash
  { term: "carwash", language: "English" },
];

/**
 * Matched anywhere in the normalised name.
 *
 * Utility words live here rather than in the token list on purpose: a bare
 * `tubig` would block "Tubig Refilling Station", which is a real Tacurong
 * business and a perfectly good Pabili stop. Paired with `bayad` it is
 * unambiguous.
 */
export const BLOCKED_CATEGORY_PHRASES: ReadonlyArray<{ term: string; language: string }> = [
  { term: "bill payment", language: "English" },
  { term: "payment center", language: "English" },
  { term: "payment centre", language: "English" },
  { term: "money transfer", language: "English" },
  { term: "financial services", language: "English" },
  // Listed as a phrase even though the bare `bayad` token would already catch
  // it: phrases are checked first, so the owner is told their name contains
  // "bayad center" rather than the vaguer "bayad". The specific message is the
  // difference between a usable rejection and a puzzling one.
  { term: "bayad center", language: "Tagalog" },
  { term: "bayad centre", language: "Tagalog" },
  { term: "pera padala", language: "Tagalog" },
  { term: "bayad tubig", language: "Tagalog (water bill)" },
  { term: "bayad kuryente", language: "Tagalog (electricity bill)" },

  // Brand-shaped names for the same service.
  { term: "palawan express", language: "brand" },
  { term: "cebuana", language: "brand" },
  { term: "ml kwarta", language: "brand" },
  { term: "western union", language: "brand" },
  { term: "bayad app", language: "brand" },

  // Motor trades
  { term: "motor trade", language: "English" },
  { term: "motor parts", language: "English" },
  { term: "auto parts", language: "English" },
  { term: "motorcycle parts", language: "English" },

  // Logistics & Express
  { term: "logistics services", language: "English" },
  { term: "courier services", language: "English" },
  { term: "express courier", language: "English" },
  { term: "cargo services", language: "English" },
  { term: "freight services", language: "English" },
  { term: "j t express", language: "brand" },
  { term: "lbc express", language: "brand" },
  { term: "jrs express", language: "brand" },
  { term: "flash express", language: "brand" },
  { term: "2go express", language: "brand" },
  { term: "spx express", language: "brand" },
  { term: "dhl express", language: "brand" },
  { term: "ninja van", language: "brand" },

  // Police Outposts & Stations
  { term: "police outpost", language: "English" },
  { term: "police station", language: "English" },
  { term: "police stations", language: "English" },
  { term: "police precinct", language: "English" },
  { term: "fire station", language: "English" },
  { term: "gas station", language: "English" },
  { term: "gasoline station", language: "English" },
  { term: "petrol station", language: "English" },
  { term: "bus station", language: "English" },
  { term: "bus terminal", language: "English" },
  { term: "transit station", language: "English" },

  // Government Offices
  { term: "government office", language: "English" },
  { term: "government offices", language: "English" },
  { term: "city hall", language: "English" },
  { term: "municipal hall", language: "English" },
  { term: "barangay hall", language: "English" },
  { term: "provincial capitol", language: "English" },
  { term: "post office", language: "English" },

  // Network / Telecom
  { term: "cable network", language: "English" },
  { term: "radio network", language: "English" },
  { term: "tv network", language: "English" },
  { term: "internet service", language: "English" },
  { term: "telecom service", language: "English" },

  // Internet Cafe / Computer Shops
  { term: "internet cafe", language: "English" },
  { term: "internet cafes", language: "English" },
  { term: "internet shop", language: "English" },
  { term: "cyber cafe", language: "English" },
  { term: "computer shop", language: "English" },
  { term: "computer cafe", language: "English" },
  { term: "net cafe", language: "English" },
  { term: "piso net", language: "Tagalog / English" },
  { term: "gaming cafe", language: "English" },

  // Nightclubs / Bars
  { term: "night club", language: "English" },
  { term: "night clubs", language: "English" },
  { term: "comedy club", language: "English" },
  { term: "videoke bar", language: "Tagalog / English" },
  { term: "karaoke bar", language: "English" },
  { term: "ktv bar", language: "English" },
  { term: "sports bar", language: "English" },
  { term: "cocktail lounge", language: "English" },
  { term: "beer house", language: "English" },

  // Salons
  { term: "beauty salon", language: "English" },
  { term: "hair salon", language: "English" },
  { term: "nail salon", language: "English" },
  { term: "barber shop", language: "English" },
  { term: "hair and beauty", language: "English" },

  // Carwash
  { term: "car wash", language: "English" },
  { term: "auto wash", language: "English" },
  { term: "car detailing", language: "English" },
  { term: "auto detailing", language: "English" },
];

/**
 * Categories the seeder deactivates on every run.
 *
 * Kept in this module beside the blocked terms so the two cannot drift: a name
 * that gets retired should also be a name that cannot be re-created, and having
 * them in separate files is how that guarantee quietly rots.
 *
 * Schools, Banks, Padala/Remittance outlets, Motor Trades, Logistics, Salons,
 * and Carwash are explicitly retired here: this system is Pabili-only (a rider buys
 * goods for the customer), so non-retail services are not fulfillable and must not
 * appear in the customer's store picker.
 *
 * NOTE: Each string must exactly match the `name` field in `merchant_categories`.
 * Add both the canonical form and any alternate spellings you find in the DB.
 */
export const RETIRED_CATEGORY_NAMES: ReadonlyArray<string> = [
  // Previously retired / test rows
  "Bills & Payment Centers",
  "Pay Bills",
  "test1",

  // Schools & Education (not a Pabili stop)
  "Schools",
  "School",
  "Schools & Education",
  "Education",
  "Educational Institution",
  "Educational Institutions",

  // Banks & Financial Services (not a Pabili stop)
  "Banks",
  "Bank",
  "Banks & Financial Services",
  "Financial Services",
  "ATM & Banks",

  // Padala / Remittance Outlets (overlaps with the blocked token list but named
  // here as exact category names so the seeder can retire them by row)
  "Padala Outlets",
  "Padala",
  "Remittance",
  "Remittance Centers",
  "Padala & Remittance",
  "Money Transfer",
  "Pera Padala",

  // Motor Trades / Parts (vehicle services, not a retail-goods Pabili stop)
  "Motor Trades",
  "Motor Trade",
  "Motorparts",
  "Motor Parts",
  "Motor Parts & Accessories",
  "Auto Parts",
  "Auto Parts & Accessories",
  "Motorcycle Parts",
  "Automotive",

  // Logistics & Freight Services (courier/cargo service, not a retail-goods Pabili stop)
  "Logistics",
  "Logistic",
  "Logicstics",
  "Logistics & Freight",
  "Logistics Services",
  "Courier",
  "Courier Services",
  "Cargo",
  "Freight",
  "Shipping",
  "Shipping & Freight",
  "Express",
  "Express Courier",

  // Police Outposts / Stations & Government Offices
  "Police Outpost",
  "Police Station",
  "Police Stations",
  "Government Offices",
  "Government Office",

  // Network / Telecom / Internet Cafe / Nightclub
  "Network",
  "Networks",
  "Internet Cafe",
  "Internet Cafes",
  "Computer Shop",
  "Nightclub",
  "Nightclubs",
  "Night Club",

  // Salons & Personal Grooming (grooming service, not a retail-goods Pabili stop)
  "Salons",
  "Salon",
  "Beauty Salon",
  "Hair Salon",
  "Hair & Beauty",
  "Barbershop",
  "Barber Shop",
  "Nail Salon",
  "Spa",
  "Spa & Salon",

  // Carwash & Detailing (vehicle cleaning service, not a retail-goods Pabili stop)
  "Carwash",
  "Car Wash",
  "Auto Wash",
  "Car Detailing",
  "Auto Detailing",
];

/**
 * Lowercase, strip diacritics, fold "&" to "and", drop punctuation, collapse
 * whitespace. So "BAYAD-CENTER", "Bayad & Payment" and "  bayad   center  " all
 * reduce to something comparable.
 */
export function normaliseCategoryName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface BlockedNameMatch {
  term: string;
  language: string;
}

/**
 * The blocked term this name contains, or null if it is fine.
 *
 * Returns the matched term rather than a boolean because the rejection message
 * has to name it. Over-blocking is the worse failure here — a wrongly blocked
 * name leaves the owner stuck with no idea why, whereas a missed one is caught at
 * the next seed run — so the error must give them something to act on.
 */
export function findBlockedCategoryTerm(name: string): BlockedNameMatch | null {
  const normalised = normaliseCategoryName(name);
  if (!normalised) return null;

  for (const phrase of BLOCKED_CATEGORY_PHRASES) {
    if (normalised.includes(normaliseCategoryName(phrase.term))) return phrase;
  }

  const words = new Set(normalised.split(" "));
  for (const token of BLOCKED_CATEGORY_TOKENS) {
    if (words.has(normaliseCategoryName(token.term))) return token;
  }

  return null;
}

const NON_PABILI_PHRASES: ReadonlyArray<string> = [
  "motor trade",
  "motor parts",
  "auto parts",
  "motorcycle parts",
  "financial service",
  "money transfer",
  "payment center",
  "pera padala",
  // Logistics
  "logistics service",
  "courier service",
  "express courier",
  "cargo forwarder",
  "freight forwarder",
  "cargo service",
  "freight service",
  "shipping service",
  // Salons
  "beauty salon",
  "hair salon",
  "nail salon",
  "barber shop",
  "hair and beauty",
  // Carwash
  "car wash",
  "auto wash",
  "car detailing",
  "auto detailing",
];

const NON_PABILI_TOKENS: ReadonlyArray<string> = [
  "school",
  "schools",
  "university",
  "college",
  "academy",
  "education",
  "educational",
  "institution",
  "bank",
  "banks",
  "atm",
  "padala",
  "remittance",
  "motorparts",
  "automotive",
  // Logistics
  "logistics",
  "logistic",
  "logicstics",
  "courier",
  "cargo",
  "freight",
  "shipping",
  // Salons
  "salon",
  "salons",
  "barbershop",
  "barber",
  "spa",
  // Carwash
  "carwash",
];

/**
 * Returns false if the category name describes a service that is out of scope
 * for Pabili (e.g. Schools, Banks, Padala Outlets, Motor Trades / parts, Utility bills).
 */
export function isPabiliCategoryName(name: string | null | undefined): boolean {
  if (!name || typeof name !== "string") return false;
  const normalised = normaliseCategoryName(name);
  if (!normalised) return false;

  // 1. Exact match against retired categories
  for (const retired of RETIRED_CATEGORY_NAMES) {
    if (normalised === normaliseCategoryName(retired)) return false;
  }

  // 2. Contains any blocked payment/bill/remittance term
  if (findBlockedCategoryTerm(name) !== null) return false;

  // 3. Contains non-pabili phrases
  for (const phrase of NON_PABILI_PHRASES) {
    if (normalised.includes(normaliseCategoryName(phrase))) return false;
  }

  // 4. Whole-word match on non-pabili tokens
  const words = new Set(normalised.split(" "));
  for (const token of NON_PABILI_TOKENS) {
    if (words.has(token)) return false;
  }

  return true;
}
