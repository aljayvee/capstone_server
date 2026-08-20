import { prisma } from "../src/lib/prisma.js";

async function seedPlaces() {
  console.log("🌱 Seeding verified merchant categories and pre-recorded Tacurong places...");

  // 1. Ensure Standard Merchant Categories Exist
  // The four in-scope Pabili store categories. "Bills & Payment Centers" was
  // deliberately removed: bills payment is not a service this system offers
  // (Pabili only), so a customer must not be able to pick it as a store type.
  // Existing rows are deactivated rather than deleted further down — VerifiedPlace
  // has a Restrict FK onto this table, and soft-deletion keeps the change
  // reversible if the scope ever widens.
  //
  // dwellP50/P80 are the seeded service-time priors: how long a rider actually
  // spends inside a store of this kind, which for an errand dominates travel
  // time. jobs/dwellLearning.ts replaces these with measured percentiles once
  // enough DwellObservation rows exist.
  const categories = [
    {
      name: "Food & Restaurant",
      description: "Fast food chains, diners, carinderias, bakeries, and cafes",
      dwellP50Seconds: 480,  // 8 min - order queue plus cook time
      dwellP80Seconds: 900,  // 15 min
    },
    {
      name: "Pharmacy & Health",
      description: "Drugstores, medical supply stores, and clinics",
      dwellP50Seconds: 360,  // 6 min - usually counter-served
      dwellP80Seconds: 720,  // 12 min
    },
    {
      name: "Supermarket & Grocery",
      description: "Supermarkets, convenience stores, and public market stalls",
      dwellP50Seconds: 900,  // 15 min - multi-item hunt plus checkout queue
      dwellP80Seconds: 1800, // 30 min
    },
    {
      name: "Retail & General Merchandise",
      description: "Department stores, hardware, school supplies, and dry goods",
      dwellP50Seconds: 600,  // 10 min - item may need finding or sizing
      dwellP80Seconds: 1200, // 20 min
    },
  ];

  // Retired store types: deactivated on every seed run so a re-seed cannot
  // silently bring them back into the customer's picker.
  const RETIRED_CATEGORY_NAMES = ["Bills & Payment Centers"];

  const catMap = new Map<string, number>();

  for (const cat of categories) {
    const record = await prisma.merchantCategory.upsert({
      where: { name: cat.name },
      update: {
        description: cat.description,
        status: "Active",
        dwellP50Seconds: cat.dwellP50Seconds,
        dwellP80Seconds: cat.dwellP80Seconds,
      },
      create: {
        name: cat.name,
        description: cat.description,
        status: "Active",
        dwellP50Seconds: cat.dwellP50Seconds,
        dwellP80Seconds: cat.dwellP80Seconds,
      },
    });
    catMap.set(cat.name, record.id);
  }

  // Retire out-of-scope categories and everything filed under them. Soft
  // deletion on purpose: VerifiedPlace.categoryId is onDelete: Restrict, so a
  // hard delete would fail while those places exist, and keeping the rows means
  // any historical errand that referenced them still resolves.
  for (const name of RETIRED_CATEGORY_NAMES) {
    const retired = await prisma.merchantCategory.findUnique({ where: { name } });
    if (!retired) continue;

    const { count } = await prisma.verifiedPlace.updateMany({
      where: { categoryId: retired.id, isActive: true },
      data: { isActive: false },
    });
    if (retired.status !== "Inactive") {
      await prisma.merchantCategory.update({
        where: { id: retired.id },
        data: { status: "Inactive" },
      });
    }
    console.log(`   Retired category "${name}" and deactivated ${count} place(s).`);
  }

  const foodCatId = catMap.get("Food & Restaurant")!;
  const pharmCatId = catMap.get("Pharmacy & Health")!;
  const grocCatId = catMap.get("Supermarket & Grocery")!;
  const retailCatId = catMap.get("Retail & General Merchandise")!;

  // 2. Pre-recorded Ground-Truth Establishments in Tacurong City
  const verifiedEstablishments = [
    // Fast Food & Chicken
    {
      name: "Chooks-to-Go Tacurong City Center",
      categoryId: foodCatId,
      address: "Alunan Highway corner Bonifacio St, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6912,
      longitude: 124.6765,
      keywords: "chooks, choox, chooks to go, lechon manok, roast chicken, liempo",
    },
    {
      name: "Chooks-to-Go Tacurong Highway",
      categoryId: foodCatId,
      address: "National Highway (near Public Market), Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6854,
      longitude: 124.6738,
      keywords: "chooks, choox, chooks to go, lechon manok, roast chicken, highway",
    },
    {
      name: "Jollibee Tacurong Center (Main)",
      categoryId: foodCatId,
      address: "National Highway, City Center, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6873,
      longitude: 124.6752,
      keywords: "jollibee, jolibee, fast food, chickenjoy, burger, center, main",
    },
    {
      name: "Jollibee Tacurong Drive-Thru (DT)",
      categoryId: foodCatId,
      address: "National Highway Bypass, Tacurong City",
      barangay: "New Isabela",
      latitude: 6.689,
      longitude: 124.6788,
      keywords: "jollibee, jolibee, dt, drive thru, drive-thru, bypass",
    },
    {
      name: "Chowking Tacurong",
      categoryId: foodCatId,
      address: "Alunan Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6865,
      longitude: 124.6749,
      keywords: "chowking, chinese food, lauriat, siopao, chao fan",
    },
    {
      name: "Mang Inasal Tacurong",
      categoryId: foodCatId,
      address: "National Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6881,
      longitude: 124.6758,
      keywords: "mang inasal, inasal, chicken inasal, unli rice",
    },
    {
      name: "Greenwich Tacurong",
      categoryId: foodCatId,
      address: "Alunan Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6869,
      longitude: 124.6745,
      keywords: "greenwich, pizza, lasagna, pasta",
    },

    // Pharmacies & Health
    {
      name: "Mercury Drug Tacurong Center",
      categoryId: pharmCatId,
      address: "Alunan Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6702,
      longitude: 124.6635,
      keywords: "mercury, mercury drug, drugstore, pharmacy, gamot, medicine, center",
    },
    {
      name: "Mercury Drug Tacurong Highway",
      categoryId: pharmCatId,
      address: "National Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6718,
      longitude: 124.665,
      keywords: "mercury, mercury drug, drugstore, pharmacy, highway, national highway",
    },
    {
      name: "Watsons Pharmacy Tacurong",
      categoryId: pharmCatId,
      address: "City Center, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6698,
      longitude: 124.6629,
      keywords: "watsons, pharmacy, skincare, health, beauty, medicine",
    },
    {
      name: "Rose Pharmacy Tacurong",
      categoryId: pharmCatId,
      address: "Bonifacio St, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6877,
      longitude: 124.6742,
      keywords: "rose pharmacy, rose, pharmacy, drugstore, medicine",
    },

    // Supermarkets & Groceries
    {
      name: "SM Supermarket / Savemore Tacurong",
      categoryId: grocCatId,
      address: "Lapu-Lapu St, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6715,
      longitude: 124.6648,
      keywords: "sm, savemore, save more, supermarket, grocery, grocery store",
    },
    {
      name: "Robinsons Supermarket Tacurong",
      categoryId: grocCatId,
      address: "National Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6728,
      longitude: 124.6659,
      keywords: "robinsons, robinson, supermarket, grocery, mall",
    },
    {
      name: "Tacurong Fitmart",
      categoryId: grocCatId,
      address: "Alunan Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6859,
      longitude: 124.6735,
      keywords: "fitmart, tacurong fitmart, department store, grocery",
    },
    {
      name: "Tacurong Public Market (Wet & Dry Section)",
      categoryId: grocCatId,
      address: "Market Site, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6845,
      longitude: 124.6721,
      keywords: "palengke, market, public market, isda, karne, gulay, fish, meat, vegetable",
    },

  ];

  for (const place of verifiedEstablishments) {
    const existing = await prisma.verifiedPlace.findFirst({
      where: { name: place.name },
    });

    if (!existing) {
      await prisma.verifiedPlace.create({
        data: {
          name: place.name,
          categoryId: place.categoryId,
          address: place.address,
          barangay: place.barangay,
          latitude: place.latitude,
          longitude: place.longitude,
          keywords: place.keywords,
          isActive: true,
        },
      });
    }
  }

  const count = await prisma.verifiedPlace.count();
  console.log(`✅ Pre-recorded Tacurong Places seeded successfully! Total places in DB: ${count}`);
}

seedPlaces()
  .catch((err) => {
    console.error("❌ Seeding failed:", err);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
