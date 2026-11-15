import {
  PrismaClient,
  RoleType,
  ErrandStatus,
  ErrandPaymentKind,
  FeedbackCategory,
  FeedbackStatus,
  BanType,
  ThreatSeverity,
  BanStatus,
  HandlingFeeMode,
} from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { RETIRED_CATEGORY_NAMES } from "../src/lib/blockedCategoryNames.js";
import { seedPassword } from "../src/lib/seedPassword.js";
import { guardSeed } from "../src/lib/seedGuard.js";

const prisma = new PrismaClient();

// Helper to chunk large arrays into batched createMany calls
async function chunkedCreateMany<T>(
  items: T[],
  chunkSize: number,
  inserter: (chunk: T[]) => Promise<unknown>
) {
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    await inserter(chunk);
  }
}

async function main() {
  guardSeed("demo");
  console.log("=========================================================");
  console.log("🌱 STARTING 500-RECORD HIGH-FIDELITY DATABASE SEEDER (SUGO) 🌱");
  console.log("=========================================================\n");

  // =========================================================================
  // 1. PAYMENT MODES & RATE CONFIGURATION
  // =========================================================================
  console.log("📦 Phase 1: Seeding Payment Modes & Pricing Configuration...");

  const paymentModes = [
    { name: "Cash on Delivery", description: "Cash payment collected at door upon delivery", status: "Active" },
    { name: "GCash / PayMaya", description: "E-wallet payment settled via company Facebook Page (50% upfront, balance at door)", status: "Active" },
    { name: "Bank Transfer", description: "Online banking payment verified via transfer slip screenshot", status: "Active" },
  ];

  const paymentModeMap = new Map<string, number>();
  for (const mode of paymentModes) {
    const record = await prisma.paymentMode.upsert({
      where: { name: mode.name },
      update: { description: mode.description, status: mode.status },
      create: mode,
    });
    paymentModeMap.set(mode.name, record.id);
  }
  console.log(`   ✔ Seeded ${paymentModes.length} payment modes.`);

  // Service Rate Configuration (Standard Tacurong Base Pricing)
  await prisma.rateConfig.upsert({
    where: { id: 1 },
    update: {
      baseFee: 50,
      perKmRate: 10,
      multiStoreFeePerStore: 30,
      maxAdditionalStores: 2,
      groceryFeeThreshold: 1001,
      groceryFeePercent: 10,
      groceryFeeFlat: 50,
      nonCodThreshold: 3000,
      nonCodFeeHigh: 15,
      nonCodFeeLow: 0,
    },
    create: {
      id: 1,
      baseFee: 50,
      perKmRate: 10,
      multiStoreFeePerStore: 30,
      maxAdditionalStores: 2,
      groceryFeeThreshold: 1001,
      groceryFeePercent: 10,
      groceryFeeFlat: 50,
      nonCodThreshold: 3000,
      nonCodFeeHigh: 15,
      nonCodFeeLow: 0,
    },
  });
  console.log("   ✔ Seeded baseline RateConfig (Base: ₱50, PerKm: ₱10, MultiStore: ₱30/store).\n");

  // =========================================================================
  // 2. MERCHANT CATEGORIES & VERIFIED TACURONG PLACES
  // =========================================================================
  console.log("🏪 Phase 2: Seeding Merchant Categories & Verified Establishments...");

  const categories = [
    {
      name: "Fast Food & Restaurant",
      description: "Fast food chains, diners, carinderias, bakeries, and cafes",
      dwellP50Seconds: 480,
      dwellP80Seconds: 900,
      geofenceRadiusMeters: 60,
      handlingFeeMode: HandlingFeeMode.NONE,
    },
    {
      name: "Pharmacy & Health",
      description: "Drugstores, medical supply stores, and clinics",
      dwellP50Seconds: 360,
      dwellP80Seconds: 720,
      geofenceRadiusMeters: 50,
      handlingFeeMode: HandlingFeeMode.NONE,
    },
    {
      name: "Supermarket & Grocery",
      description: "Supermarkets, convenience stores, and public market stalls",
      dwellP50Seconds: 900,
      dwellP80Seconds: 1800,
      geofenceRadiusMeters: 100,
      handlingFeeMode: HandlingFeeMode.PERCENT,
    },
    {
      name: "Retail & General Merchandise",
      description: "Department stores, hardware, school supplies, and dry goods",
      dwellP50Seconds: 600,
      dwellP80Seconds: 1200,
      geofenceRadiusMeters: 75,
      handlingFeeMode: HandlingFeeMode.THRESHOLD,
    },
    {
      name: "Bakery & Pastry",
      description: "Local bakeshops, cake shops, and bread stores",
      dwellP50Seconds: 300,
      dwellP80Seconds: 600,
      geofenceRadiusMeters: 50,
      handlingFeeMode: HandlingFeeMode.NONE,
    },
    {
      name: "Cafe",
      description: "Coffee shops, beverage stalls, and milk tea spots",
      dwellP50Seconds: 420,
      dwellP80Seconds: 780,
      geofenceRadiusMeters: 50,
      handlingFeeMode: HandlingFeeMode.NONE,
    },
  ];

  const catMap = new Map<string, number>();
  for (const cat of categories) {
    const record = await prisma.merchantCategory.upsert({
      where: { name: cat.name },
      update: {
        description: cat.description,
        status: "Active",
        dwellP50Seconds: cat.dwellP50Seconds,
        dwellP80Seconds: cat.dwellP80Seconds,
        geofenceRadiusMeters: cat.geofenceRadiusMeters,
      },
      create: {
        name: cat.name,
        description: cat.description,
        status: "Active",
        dwellP50Seconds: cat.dwellP50Seconds,
        dwellP80Seconds: cat.dwellP80Seconds,
        geofenceRadiusMeters: cat.geofenceRadiusMeters,
        handlingFeeMode: cat.handlingFeeMode,
      },
    });
    catMap.set(cat.name, record.id);
  }

  // Safely deactivate retired categories
  for (const retiredName of RETIRED_CATEGORY_NAMES) {
    const retired = await prisma.merchantCategory.findUnique({ where: { name: retiredName } });
    if (retired) {
      await prisma.verifiedPlace.updateMany({
        where: { categoryId: retired.id, isActive: true },
        data: { isActive: false },
      });
      if (retired.status !== "Inactive") {
        await prisma.merchantCategory.update({
          where: { id: retired.id },
          data: { status: "Inactive" },
        });
      }
    }
  }

  // Ground-Truth Establishments in Tacurong City across all 6 categories
  const foodCatId = catMap.get("Fast Food & Restaurant")!;
  const pharmCatId = catMap.get("Pharmacy & Health")!;
  const grocCatId = catMap.get("Supermarket & Grocery")!;
  const retailCatId = catMap.get("Retail & General Merchandise")!;
  const bakeryCatId = catMap.get("Bakery & Pastry")!;
  const cafeCatId = catMap.get("Cafe")!;

  const places = [
    {
      name: "Jollibee Tacurong Center (Main)",
      categoryId: foodCatId,
      address: "National Highway, City Center, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6873,
      longitude: 124.6752,
      keywords: "jollibee, fast food, chickenjoy, burger, center, main",
      googlePlaceId: "ChIJ11111111111111111111111",
    },
    {
      name: "Mercury Drug Tacurong Center",
      categoryId: pharmCatId,
      address: "Alunan Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6702,
      longitude: 124.6635,
      keywords: "mercury drug, drugstore, pharmacy, medicine, gamot",
      googlePlaceId: "ChIJ22222222222222222222222",
    },
    {
      name: "SM Supermarket / Savemore Tacurong",
      categoryId: grocCatId,
      address: "Lapu-Lapu St, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6715,
      longitude: 124.6648,
      keywords: "sm, savemore, supermarket, grocery, food",
      googlePlaceId: "ChIJ33333333333333333333333",
    },
    {
      name: "Tacurong Fitmart",
      categoryId: retailCatId,
      address: "Alunan Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6859,
      longitude: 124.6735,
      keywords: "fitmart, department store, school supplies, retail",
      googlePlaceId: "ChIJ44444444444444444444444",
    },
    {
      name: "Chowking Tacurong",
      categoryId: foodCatId,
      address: "Alunan Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6865,
      longitude: 124.6749,
      keywords: "chowking, chinese, halo halo, chao fan, siomai",
      googlePlaceId: "ChIJ55555555555555555555555",
    },
    {
      name: "Rose Pharmacy Tacurong",
      categoryId: pharmCatId,
      address: "Bonifacio St, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6877,
      longitude: 124.6742,
      keywords: "rose pharmacy, rose, drugstore, medicine",
      googlePlaceId: "ChIJ66666666666666666666666",
    },
    {
      name: "Tacurong Public Market (Wet & Dry Section)",
      categoryId: grocCatId,
      address: "Market Site, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6845,
      longitude: 124.6721,
      keywords: "market, palengke, public market, fish, meat, vegetable",
      googlePlaceId: "ChIJ77777777777777777777777",
    },
    {
      name: "Chooks-to-Go Tacurong City Center",
      categoryId: foodCatId,
      address: "Alunan Highway corner Bonifacio St, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6912,
      longitude: 124.6765,
      keywords: "chooks, roast chicken, liempo",
      googlePlaceId: "ChIJ88888888888888888888888",
    },
    {
      name: "Mang Inasal Tacurong Highway",
      categoryId: foodCatId,
      address: "National Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6881,
      longitude: 124.6758,
      keywords: "mang inasal, chicken inasal, unli rice, barbecue",
      googlePlaceId: "ChIJ99999999999999999999999",
    },
    {
      name: "Greenwich Pizza Tacurong",
      categoryId: foodCatId,
      address: "Alunan Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6868,
      longitude: 124.6746,
      keywords: "greenwich, pizza, pasta, lasagna",
      googlePlaceId: "ChIJaaaaaaaaaaaaaaaaaaaaaaa",
    },
    {
      name: "Watsons Tacurong Mall",
      categoryId: pharmCatId,
      address: "Ground Level, City Mall, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.689,
      longitude: 124.676,
      keywords: "watsons, pharmacy, beauty, vitamins, skin care",
      googlePlaceId: "ChIJbbbbbbbbbbbbbbbbbbbbbbb",
    },
    {
      name: "7-Eleven Tacurong Alunan",
      categoryId: grocCatId,
      address: "Alunan Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6852,
      longitude: 124.6738,
      keywords: "7-eleven, convenience store, snacks, drinks, 24/7",
      googlePlaceId: "ChIJccccccccccccccccccccccc",
    },
    {
      name: "Red Ribbon Bakeshop Tacurong",
      categoryId: bakeryCatId,
      address: "Alunan Highway, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6862,
      longitude: 124.6744,
      keywords: "red ribbon, bakeshop, cakes, rolls, ensaymada, pastries",
      googlePlaceId: "ChIJddddddddddddddddddddddd",
    },
    {
      name: "Goldilocks Tacurong Center",
      categoryId: bakeryCatId,
      address: "Bonifacio St, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6872,
      longitude: 124.6739,
      keywords: "goldilocks, bakeshop, cake, polvoron, mocha, pastries",
      googlePlaceId: "ChIJeeeeeeeeeeeeeeeeeeeeeee",
    },
    {
      name: "Mac's Bakeshop Tacurong",
      categoryId: bakeryCatId,
      address: "Magsaysay St, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6888,
      longitude: 124.6748,
      keywords: "mac's bakeshop, pan de sal, spanish bread, local bakery",
      googlePlaceId: "ChIJfffffffffffffffffffffff",
    },
    {
      name: "Coffee Bear Cafe Tacurong",
      categoryId: cafeCatId,
      address: "Lapu-Lapu St, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6848,
      longitude: 124.6718,
      keywords: "coffee bear, cafe, iced latte, cold brew, frappe",
      googlePlaceId: "ChIJggggggggggggggggggggggg",
    },
    {
      name: "Decent Cup Coffee Shop",
      categoryId: cafeCatId,
      address: "City Center, Tacurong City",
      barangay: "Poblacion",
      latitude: 6.6875,
      longitude: 124.6755,
      keywords: "decent cup, specialty coffee, espresso, tea",
      googlePlaceId: "ChIJhhhhhhhhhhhhhhhhhhhhhhh",
    },
    {
      name: "KCC Department Store Tacurong",
      categoryId: retailCatId,
      address: "National Highway, Tacurong City",
      barangay: "New Isabela",
      latitude: 6.6925,
      longitude: 124.6795,
      keywords: "kcc, department store, clothes, shoes, appliances, retail",
      googlePlaceId: "ChIJiiiiiiiiiiiiiiiiiiiiiii",
    },
  ];

  const placeMap = new Map<string, string>();
  for (const p of places) {
    const existing = await prisma.verifiedPlace.findFirst({ where: { name: p.name } });
    if (existing) {
      await prisma.verifiedPlace.update({
        where: { id: existing.id },
        data: {
          categoryId: p.categoryId,
          address: p.address,
          barangay: p.barangay,
          latitude: p.latitude,
          longitude: p.longitude,
          keywords: p.keywords,
          googlePlaceId: p.googlePlaceId,
          isActive: true,
        },
      });
      placeMap.set(p.name, existing.id);
    } else {
      const created = await prisma.verifiedPlace.create({
        data: {
          name: p.name,
          categoryId: p.categoryId,
          address: p.address,
          barangay: p.barangay,
          latitude: p.latitude,
          longitude: p.longitude,
          keywords: p.keywords,
          googlePlaceId: p.googlePlaceId,
          isActive: true,
        },
      });
      placeMap.set(p.name, created.id);
    }
  }
  console.log(`   ✔ Seeded ${places.length} verified Tacurong establishments across all 6 categories.\n`);

  // =========================================================================
  // 3. OPERATIONAL STAFF (OWNER, DISPATCHERS, RIDERS) & SYSADMIN
  // =========================================================================
  console.log("👥 Phase 3: Seeding Staff Accounts & System Administrators...");

  const ownerPass = await bcrypt.hash(seedPassword("OWNER_SEED_PASSWORD"), 10);
  const staffPass = await bcrypt.hash(seedPassword("STAFF_SEED_PASSWORD"), 10);
  const sysAdminPass = await bcrypt.hash(seedPassword("SYSADMIN_SEED_PASSWORD"), 10);

  // 3a. Owner (PRESERVE if already exists on VPS)
  let owner = await prisma.user.findUnique({ where: { username: "owner" } });
  if (owner) {
    console.log(`   ℹ Existing Owner account found (${owner.username} / ${owner.email}) - PRESERVING credentials and profile.`);
  } else {
    owner = await prisma.user.create({
      data: {
        username: "owner",
        passwordHash: ownerPass,
        role: RoleType.OWNER,
        firstName: "Aljayvee",
        middleName: "P.",
        lastName: "Versola",
        email: "aj.versola@company.ph",
        phone: "09171234567",
        avatar: "AV",
        status: "Active",
        profileCompleted: true,
        emailVerified: true,
        phoneVerified: true,
      },
    });
  }

  // 3b. Dispatchers (PRESERVE if already exists)
  let dispatcher1 = await prisma.user.findUnique({ where: { username: "dispatcher1" } });
  if (dispatcher1) {
    console.log(`   ℹ Existing dispatcher1 found - PRESERVING credentials.`);
  } else {
    dispatcher1 = await prisma.user.create({
      data: {
        username: "dispatcher1",
        passwordHash: staffPass,
        role: RoleType.DISPATCHER,
        firstName: "Maria",
        middleName: "C.",
        lastName: "Santos",
        email: "dispatcher1@sugo-express.org",
        phone: "09175551001",
        avatar: "MS",
        status: "Active",
        profileCompleted: true,
        emailVerified: true,
        phoneVerified: true,
      },
    });
  }

  let dispatcher2 = await prisma.user.findUnique({ where: { username: "dispatcher2" } });
  if (dispatcher2) {
    console.log(`   ℹ Existing dispatcher2 found - PRESERVING credentials.`);
  } else {
    dispatcher2 = await prisma.user.create({
      data: {
        username: "dispatcher2",
        passwordHash: staffPass,
        role: RoleType.DISPATCHER,
        firstName: "Juan",
        middleName: "M.",
        lastName: "Dela Cruz",
        email: "dispatcher2@sugo-express.org",
        phone: "09175551002",
        avatar: "JD",
        status: "Active",
        profileCompleted: true,
        emailVerified: true,
        phoneVerified: true,
      },
    });
  }

  // 3c. Riders (5 active fleet riders - PRESERVE if already exists)
  const riderDefs = [
    { username: "rider1", firstName: "Pedro", middleName: "B.", lastName: "Penduko", email: "rider1@sugo-express.org", phone: "09187771001", avatar: "PP", lat: 6.687, lng: 124.675, onDuty: true },
    { username: "rider2", firstName: "Jose", middleName: "P.", lastName: "Rizal", email: "rider2@sugo-express.org", phone: "09187771002", avatar: "JR", lat: 6.671, lng: 124.664, onDuty: true },
    { username: "rider3", firstName: "Andres", middleName: "E.", lastName: "Bonifacio", email: "rider3@sugo-express.org", phone: "09187771003", avatar: "AB", lat: 6.685, lng: 124.672, onDuty: true },
    { username: "rider4", firstName: "Emilio", middleName: "F.", lastName: "Aguinaldo", email: "rider4@sugo-express.org", phone: "09187771004", avatar: "EA", lat: 6.690, lng: 124.678, onDuty: true },
    { username: "rider5", firstName: "Juan", middleName: "N.", lastName: "Luna", email: "rider5@sugo-express.org", phone: "09187771005", avatar: "JL", lat: 6.678, lng: 124.669, onDuty: false },
  ];

  const riders: { id: number; username: string }[] = [];
  for (const r of riderDefs) {
    let user = await prisma.user.findUnique({ where: { username: r.username } });
    if (user) {
      console.log(`   ℹ Existing rider ${r.username} found - PRESERVING credentials.`);
    } else {
      user = await prisma.user.create({
        data: {
          username: r.username,
          passwordHash: staffPass,
          role: RoleType.RIDER,
          firstName: r.firstName,
          middleName: r.middleName,
          lastName: r.lastName,
          email: r.email,
          phone: r.phone,
          avatar: r.avatar,
          status: "Active",
          profileCompleted: true,
          emailVerified: true,
          phoneVerified: true,
        },
      });
      await prisma.riderPresence.create({
        data: {
          riderId: user.id,
          onDuty: r.onDuty,
          latitude: r.lat,
          longitude: r.lng,
          accuracyMeters: 4.5,
          headingDeg: 90.0,
          connectivity: "cellular",
          beaconIntervalMs: 15000,
          lastBeaconAt: new Date(),
          recordedAt: new Date(),
        },
      });
    }
    riders.push(user);
  }

  // 3d. System Administrator (IT DevOps Account - PRESERVE if already exists)
  let sysAdmin = await prisma.sysAdmin.findUnique({ where: { username: "sysadminit" } });
  if (sysAdmin) {
    console.log(`   ℹ Existing sysadminit found - PRESERVING credentials.`);
  } else {
    sysAdmin = await prisma.sysAdmin.create({
      data: {
        username: "sysadminit",
        passwordHash: sysAdminPass,
        firstName: "DevOps",
        lastName: "Administrator",
        email: "sysadmin@sugo-express.org",
        phone: "09179998877",
        role: "SYSADMIN",
        status: "Active",
        profileCompleted: true,
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
  }
  console.log(`   ✔ Verified Owner, 2 Dispatchers, ${riders.length} Riders with live Presence, and SysAdmin.\n`);

  // =========================================================================
  // 4. SEEDING 60 REALISTIC CUSTOMER ACCOUNTS ACROSS TACURONG
  // =========================================================================
  console.log("👤 Phase 4: Seeding 60 Customers with Complete Profiles & Saved Delivery Locations...");

  const customerPass = await bcrypt.hash(seedPassword("CUSTOMER_SEED_PASSWORD"), 10);

  // Tacurong Barangays and reference coordinates
  const barangays = [
    { name: "Poblacion", lat: 6.688, lng: 124.675, streets: ["Magsaysay St", "Alunan Highway", "Bonifacio St", "Lapu-Lapu St", "Rizal Ave"] },
    { name: "New Isabela", lat: 6.693, lng: 124.681, streets: ["Purok Rosal", "Sampaguita Lane", "National Highway Bypass", "Orchids St"] },
    { name: "Griño", lat: 6.696, lng: 124.686, streets: ["Griño Proper Road", "Bypass Highway", "Purok Pag-asa", "School Lane"] },
    { name: "San Emmanuel", lat: 6.678, lng: 124.662, streets: ["San Emmanuel Main St", "Purok 1 Road", "Irrigation Side", "Barangay Road"] },
    { name: "Buenaflor", lat: 6.702, lng: 124.674, streets: ["Buenaflor Highway", "Purok Malipayon", "Chapel Road"] },
    { name: "Calean", lat: 6.671, lng: 124.695, streets: ["Calean Road", "Purok Masagana", "Sitio Crossing"] },
    { name: "Carmen", lat: 6.712, lng: 124.665, streets: ["Carmen Proper", "Carmen-Isulan Boundary", "Purok Sunshine"] },
    { name: "EJC Montilla", lat: 6.664, lng: 124.658, streets: ["Montilla Highway", "Purok Mabuhay", "Old Mill Road"] },
    { name: "Kalandagan", lat: 6.682, lng: 124.698, streets: ["Kalandagan Road", "Purok 3", "Boundary St"] },
    { name: "Rajah Muda", lat: 6.698, lng: 124.692, streets: ["Rajah Muda Central", "Purok Daisy", "Canal Road"] },
    { name: "San Pablo", lat: 6.685, lng: 124.652, streets: ["San Pablo St", "Purok Riverside", "Farm Road"] },
    { name: "Baras", lat: 6.674, lng: 124.679, streets: ["Baras Bird Sanctuary Road", "Purok Kawayan", "Lake View"] },
  ];

  // 60 customer personas
  const customerNames = [
    { first: "Ana", middle: "G.", last: "Lim", username: "customer_ana" },
    { first: "Mark", middle: "S.", last: "Reyes", username: "customer_mark" },
    { first: "Lea", middle: "V.", last: "Salonga", username: "customer_lea" },
    { first: "Carlos", middle: "E.", last: "Yulo", username: "customer_carlos" },
    { first: "Gabriel", middle: "P.", last: "Mendoza", username: "customer_gabriel" },
    { first: "Carmela", middle: "M.", last: "Santos", username: "customer_carmela" },
    { first: "Rafael", middle: "T.", last: "Tan", username: "customer_rafael" },
    { first: "Angelica", middle: "D.", last: "Dizon", username: "customer_angelica" },
    { first: "Mateo", middle: "B.", last: "Bautista", username: "customer_mateo" },
    { first: "Kristine", middle: "R.", last: "Ramos", username: "customer_kristine" },
    { first: "Joshua", middle: "A.", last: "Aquino", username: "customer_joshua" },
    { first: "Clarisse", middle: "V.", last: "Villanueva", username: "customer_clarisse" },
    { first: "Paolo", middle: "S.", last: "Soriano", username: "customer_paolo" },
    { first: "Diane", middle: "C.", last: "Castro", username: "customer_diane" },
    { first: "Emmanuel", middle: "N.", last: "Navarro", username: "customer_emmanuel" },
    { first: "Beatrice", middle: "F.", last: "Flores", username: "customer_beatrice" },
    { first: "Christian", middle: "S.", last: "Salazar", username: "customer_christian" },
    { first: "Alyssa", middle: "C.", last: "Cortez", username: "customer_alyssa" },
    { first: "Jerome", middle: "O.", last: "Ocampo", username: "customer_jerome" },
    { first: "Patricia", middle: "D.", last: "Delos Reyes", username: "customer_patricia" },
    { first: "Dominic", middle: "M.", last: "Morales", username: "customer_dominic" },
    { first: "Kimberly", middle: "D.", last: "David", username: "customer_kimberly" },
    { first: "Angelo", middle: "R.", last: "Rivera", username: "customer_angelo" },
    { first: "Stephanie", middle: "R.", last: "Roxas", username: "customer_stephanie" },
    { first: "Adrian", middle: "G.", last: "Guzman", username: "customer_adrian" },
    { first: "Camille", middle: "T.", last: "Tolentino", username: "customer_camille" },
    { first: "Vincent", middle: "A.", last: "Alcantara", username: "customer_vincent" },
    { first: "Andrea", middle: "M.", last: "Mercado", username: "customer_andrea" },
    { first: "Miguel", middle: "S.", last: "Santiago", username: "customer_miguel" },
    { first: "Joanna", middle: "V.", last: "Valenzuela", username: "customer_joanna" },
    { first: "Kenneth", middle: "C.", last: "Corpuz", username: "customer_kenneth" },
    { first: "Nicole", middle: "P.", last: "Pascual", username: "customer_nicole" },
    { first: "Bryan", middle: "M.", last: "Manalo", username: "customer_bryan" },
    { first: "Elena", middle: "P.", last: "Perez", username: "customer_elena" },
    { first: "Richard", middle: "G.", last: "Gomez", username: "customer_richard" },
    { first: "Maricel", middle: "S.", last: "Soriano", username: "customer_maricel" },
    { first: "Aga", middle: "M.", last: "Muhlach", username: "customer_aga" },
    { first: "Vilma", middle: "S.", last: "Santos", username: "customer_vilma" },
    { first: "Christopher", middle: "D.", last: "De Leon", username: "customer_christopher" },
    { first: "Judy Ann", middle: "S.", last: "Santos", username: "customer_judy" },
    { first: "Piolo", middle: "P.", last: "Pascual", username: "customer_piolo" },
    { first: "Marian", middle: "R.", last: "Rivera", username: "customer_marian" },
    { first: "Dingdong", middle: "D.", last: "Dantes", username: "customer_dingdong" },
    { first: "Kathryn", middle: "B.", last: "Bernardo", username: "customer_kathryn" },
    { first: "Daniel", middle: "P.", last: "Padilla", username: "customer_daniel" },
    { first: "Liza", middle: "S.", last: "Soberano", username: "customer_liza" },
    { first: "Enrique", middle: "G.", last: "Gil", username: "customer_enrique" },
    { first: "Nadine", middle: "L.", last: "Lustre", username: "customer_nadine" },
    { first: "James", middle: "R.", last: "Reid", username: "customer_james" },
    { first: "Sarah", middle: "G.", last: "Geronimo", username: "customer_sarah" },
    { first: "Matteo", middle: "G.", last: "Guidicelli", username: "customer_matteo_g" },
    { first: "Bea", middle: "A.", last: "Alonzo", username: "customer_bea" },
    { first: "John Lloyd", middle: "C.", last: "Cruz", username: "customer_john" },
    { first: "Anne", middle: "C.", last: "Curtis", username: "customer_anne" },
    { first: "Catriona", middle: "G.", last: "Gray", username: "customer_catriona" },
    { first: "Pia", middle: "W.", last: "Wurtzbach", username: "customer_pia" },
    { first: "Hidilyn", middle: "D.", last: "Diaz", username: "customer_hidilyn" },
    { first: "Rowena", middle: "F.", last: "Morales", username: "customer_rowena" },
    { first: "Darwin", middle: "L.", last: "Castillo", username: "customer_darwin" },
    { first: "Glenda", middle: "P.", last: "Aguilar", username: "customer_glenda" },
  ];

  const customerList: { id: number; username: string; defaultLoc: { address: string; street: string; landmark: string; notes: string; lat: number; lng: number } }[] = [];

  for (let i = 0; i < customerNames.length; i++) {
    const cn = customerNames[i];
    const bg = barangays[i % barangays.length];
    const street = bg.streets[i % bg.streets.length];
    const lat = bg.lat + (Math.sin(i) * 0.003);
    const lng = bg.lng + (Math.cos(i) * 0.003);
    const phone = `0919${String(1000000 + i).slice(1)}`;
    const email = `${cn.username}@gmail.com`;
    const defaultLoc = {
      address: `${street}, Brgy. ${bg.name}, Tacurong City`,
      street,
      landmark: `Near Brgy. ${bg.name} Center`,
      notes: i % 2 === 0 ? "Green gate, knock loudly" : "Please call upon arrival",
      lat,
      lng,
    };

    let account = await prisma.customerAccount.findUnique({
      where: { username: cn.username },
    });

    if (!account) {
      account = await prisma.customerAccount.create({
        data: {
          username: cn.username,
          email,
          passwordHash: customerPass,
          status: "Active",
          emailVerified: true,
          phoneVerified: true,
        },
      });

      await prisma.customerInformation.create({
        data: {
          customerId: account.id,
          firstName: cn.first,
          middleName: cn.middle,
          lastName: cn.last,
          birthdate: new Date(1990 + (i % 12), i % 12, (i % 27) + 1),
          phone,
          phoneVerified: true,
          phoneVerifiedAt: new Date(),
          avatar: `${cn.first[0]}${cn.last[0]}`,
        },
      });

      await prisma.savedDeliveryLocation.create({
        data: {
          customerId: account.id,
          label: "Home",
          address: defaultLoc.address,
          streetName: defaultLoc.street,
          landmark: defaultLoc.landmark,
          notes: defaultLoc.notes,
          latitude: defaultLoc.lat,
          longitude: defaultLoc.lng,
          isDefault: true,
        },
      });
    }

    customerList.push({
      id: account.id,
      username: account.username,
      defaultLoc,
    });
  }
  console.log(`   ✔ Seeded ${customerList.length} customer accounts with profiles and Tacurong GPS addresses.\n`);

  // =========================================================================
  // 5. GENERATING & SEEDING 500 REALISTIC SYSTEM ERRANDS
  // =========================================================================
  console.log("🛵 Phase 5: Generating 500 Errands across Tacurong City...");
  console.log("   Distribution: 400 COMPLETED, 30 IN_TRANSIT, 25 ASSIGNED, 25 PENDING, 20 CANCELLED");

  // Rich item catalogs per category
  const itemCatalog: Record<string, { name: string; price: number; size: string; notes: string }[]> = {
    "Fast Food & Restaurant": [
      { name: "2pc Chickenjoy with Rice", price: 180, size: "Regular", notes: "Spicy please" },
      { name: "1pc Chickenjoy with Palabok", price: 215, size: "Regular", notes: "With gravy" },
      { name: "Jolly Spaghetti Solo", price: 60, size: "Solo", notes: "Extra cheese" },
      { name: "Yumburger Solo", price: 40, size: "Regular", notes: "Fresh" },
      { name: "Champ Burger with Fries", price: 210, size: "Regular", notes: "No pickles" },
      { name: "Peach Mango Pie 3-Pack", price: 145, size: "Box of 3", notes: "Crispy" },
      { name: "Chao Fan with Fried Siomai", price: 110, size: "Regular", notes: "With chili and calamansi" },
      { name: "Halo-Halo Supreme", price: 110, size: "Supreme", notes: "Extra ube and milk" },
      { name: "Pork Chao Fan with Egg", price: 125, size: "Regular", notes: "Hot" },
      { name: "Mang Inasal PM1 Chicken Inasal", price: 155, size: "Pecho Large", notes: "With chicken oil" },
      { name: "Chooks Sweet Roast Chicken", price: 340, size: "Whole chicken", notes: "Cut into 4 pieces" },
      { name: "Chooks Pepper Roast Chicken", price: 340, size: "Whole chicken", notes: "Juicy" },
      { name: "Hawaiian Overload Pizza", price: 299, size: "Medium 9-inch", notes: "Double cheese" },
      { name: "Lasagna Supreme Solo", price: 130, size: "Solo", notes: "With garlic bread" },
    ],
    "Pharmacy & Health": [
      { name: "Biogesic 500mg (10 tabs)", price: 110, size: "1 blister pack", notes: "Paracetamol for fever" },
      { name: "Neozep Forte (10 tabs)", price: 95, size: "1 blister pack", notes: "For cold relief" },
      { name: "Bioflu (10 tabs)", price: 120, size: "1 blister pack", notes: "Flu medication" },
      { name: "Salonpas Medicated Patch 10s", price: 85, size: "10 sheets pack", notes: "Pain relief" },
      { name: "Pocari Sweat Ion Drink", price: 55, size: "500ml bottle", notes: "Chilled if possible" },
      { name: "Ascorbic Acid Vitamin C 100s", price: 350, size: "100 capsules bottle", notes: "500mg with Zinc" },
      { name: "Betadine Antiseptic Solution", price: 140, size: "30ml bottle", notes: "First aid" },
      { name: "Mediplast Adhesive Bandage", price: 45, size: "Box of 20", notes: "Waterproof" },
      { name: "70% Isopropyl Alcohol", price: 85, size: "500ml bottle", notes: "With moisturizer" },
      { name: "Cetirizine 10mg (10 tabs)", price: 150, size: "1 blister pack", notes: "For allergy relief" },
    ],
    "Supermarket & Grocery": [
      { name: "Brown Rice", price: 60, size: "1 kg pack", notes: "Sinandomeng or Dinorado" },
      { name: "White Dinorado Rice", price: 280, size: "5 kg bag", notes: "Fresh stock" },
      { name: "Purefoods Corned Beef", price: 180, size: "380g can", notes: "Check expiration date" },
      { name: "San Marino Corned Tuna", price: 55, size: "180g can", notes: "Chili flavor" },
      { name: "Golden Fiesta Cooking Oil", price: 110, size: "1 Liter bottle", notes: "Pure canola" },
      { name: "Bear Brand Powdered Milk", price: 440, size: "900g pack", notes: "Fortified" },
      { name: "Lucky Me Instant Pancit Canton", price: 75, size: "Pack of 5", notes: "Calamansi flavor" },
      { name: "Datu Puti Vinegar & Soy Sauce", price: 95, size: "Twin pack 1L", notes: "Standard duo" },
      { name: "Fresh Brown Eggs (Tray of 30)", price: 260, size: "1 Tray (30 pcs)", notes: "Handle with extra care" },
      { name: "Surf Powder Detergent", price: 230, size: "2.2kg pouch", notes: "Blossom Fresh" },
      { name: "Safeguard Pure White Soap", price: 135, size: "3-bar pack", notes: "Antibacterial" },
      { name: "Colgate Total Toothpaste", price: 145, size: "150g tube", notes: "Clean mint" },
    ],
    "Bakery & Pastry": [
      { name: "Fresh Pan de Sal", price: 30, size: "10 pcs bag", notes: "Warm from the oven" },
      { name: "Spanish Bread", price: 45, size: "6 pcs pack", notes: "Sweet buttery filling" },
      { name: "Cheese Ensaymada", price: 160, size: "Box of 4", notes: "Topped with grated cheddar" },
      { name: "Ube Bloom Cake Roll", price: 280, size: "Half roll", notes: "For celebration" },
      { name: "Choco Moist Cake Slice", price: 55, size: "1 slice", notes: "Fudge frosting" },
      { name: "Dunkin' Boston Kreme & Choco Butternut", price: 240, size: "Half dozen box", notes: "Assorted donuts" },
    ],
    "Cafe": [
      { name: "Iced Spanish Latte", price: 140, size: "16oz cup", notes: "Less sweet, extra ice" },
      { name: "Caramel Macchiato", price: 150, size: "16oz cup", notes: "Oat milk if available" },
      { name: "Matcha Green Tea Latte", price: 160, size: "16oz cup", notes: "Cold, 50% sugar" },
      { name: "Cold Brew Coffee", price: 130, size: "500ml glass bottle", notes: "Black" },
      { name: "Dark Chocolate Mocha Frappe", price: 170, size: "16oz cup", notes: "With whipped cream" },
    ],
    "Retail & General Merchandise": [
      { name: "Pilot G-Tech 0.3 Gel Pen", price: 95, size: "Black ink", notes: "Original Japanese refill" },
      { name: "Corona Spiral Notebook", price: 70, size: "80 leaves (2 pcs)", notes: "Any cover color" },
      { name: "Hard Copy Bond Paper A4", price: 240, size: "1 Ream (500 sheets)", notes: "70 gsm" },
      { name: "Standard Extension Cord 3M", price: 220, size: "3-meter cord", notes: "Universal sockets" },
      { name: "LED Light Bulb 9W Warm", price: 115, size: "9W E27 socket", notes: "Warm white" },
    ],
  };

  // Map category names to places
  const categoryPlaces: Record<string, typeof places> = {
    "Fast Food & Restaurant": places.filter((p) => p.categoryId === foodCatId),
    "Pharmacy & Health": places.filter((p) => p.categoryId === pharmCatId),
    "Supermarket & Grocery": places.filter((p) => p.categoryId === grocCatId),
    "Retail & General Merchandise": places.filter((p) => p.categoryId === retailCatId),
    "Bakery & Pastry": places.filter((p) => p.categoryId === bakeryCatId),
    "Cafe": places.filter((p) => p.categoryId === cafeCatId),
  };

  const codModeId = paymentModeMap.get("Cash on Delivery")!;
  const gcashModeId = paymentModeMap.get("GCash / PayMaya")!;
  const bankModeId = paymentModeMap.get("Bank Transfer")!;

  const now = new Date();

  // Define the target statuses for the 500 errands
  // 400 COMPLETED, 30 IN_TRANSIT, 25 ASSIGNED, 25 PENDING, 20 CANCELLED
  const statusPlans: { status: ErrandStatus; count: number }[] = [
    { status: ErrandStatus.COMPLETED, count: 400 },
    { status: ErrandStatus.IN_TRANSIT, count: 30 },
    { status: ErrandStatus.ASSIGNED, count: 25 },
    { status: ErrandStatus.PENDING, count: 25 },
    { status: ErrandStatus.CANCELLED, count: 20 },
  ];

  interface ErrandBatchData {
    errand: {
      id: string;
      category: string;
      description: string;
      pickupAddress: string;
      deliveryAddress: string;
      deliveryLatitude: number;
      deliveryLongitude: number;
      deliveryStreetName: string;
      deliveryLandmark: string;
      deliveryNotes: string;
      estimatedCost: number;
      deliveryFee: number;
      tip: number;
      totalCost: number;
      status: ErrandStatus;
      storeCount: number;
      customerId: number;
      riderId: number | null;
      paymentModeId: number;
      paymentEnabledAt: Date | null;
      paymentEnabledByDispatcherId: number | null;
      itemsPurchasedAt: Date | null;
      assignedAt: Date | null;
      acceptedAt: Date | null;
      deliveredAt: Date | null;
      completedAt: Date | null;
      distanceKm: number;
      routeDistanceMeters: number;
      routeDurationSeconds: number;
      routeProvider: string;
      multiStoreFee: number;
      groceryFee: number;
      nonCodFee: number;
      distanceFee: number;
      feeCalculatedAt: Date;
      quotedHandlingBasket: number;
      quotedHandlingFee: number;
      quotedDeliveryFee: number;
      etaLowAt: Date;
      etaHighAt: Date;
      etaComputedAt: Date;
      createdAt: Date;
      updatedAt: Date;
    };
    pinpoints: {
      errandId: string;
      sequence: number;
      storeName: string;
      latitude: number;
      longitude: number;
      categoryId: number;
      placeId: string | null;
      arrivedAt: Date | null;
      departedAt: Date | null;
      legDistanceMeters: number;
      legDurationSeconds: number;
      createdAt: Date;
    }[];
    items: {
      errandId: string;
      sequence: number; // to link to pinpoint sequence
      itemName: string;
      storeCategory: string;
      quantity: number;
      size: string;
      notes: string;
      unitPrice: number;
      estimatedSubtotal: number;
      fulfillmentStatus: string;
      createdAt: Date;
    }[];
    transaction: {
      customerId: number;
      errandId: string;
      amount: number;
      paymentMethod: string;
      status: string;
      paidAt: Date | null;
      createdAt: Date;
    };
    paymentSelection: {
      id: string;
      errandId: string;
      paymentModeId: number;
      confirmedAt: Date;
    };
    dispatchLog: {
      errandId: string;
      dispatcherId: number;
      notes: string;
      dispatchedAt: Date;
      verifiedAt: Date | null;
    } | null;
    settlement: {
      errandId: string;
      riderId: number;
      expectedAmount: number;
      collectedAmount: number;
      variance: number;
      status: string;
      shortReason: string | null;
      settledAt: Date;
    } | null;
    commission: {
      errandId: string;
      riderId: number;
      deliveryFee: number;
      tip: number;
      commissionRate: number;
      riderShare: number;
      businessShare: number;
      itemCostExcluded: number;
      computedAt: Date;
    } | null;
    rating: {
      errandId: string;
      riderId: number;
      stars: number;
      comment: string;
      createdAt: Date;
    } | null;
    declineReason: {
      errandId: string;
      dispatcherId: number;
      reason: string;
      isCustom: boolean;
      createdAt: Date;
    } | null;
    trackPoints: {
      errandId: string;
      riderId: number;
      latitude: number;
      longitude: number;
      accuracyMeters: number;
      speedMps: number;
      headingDeg: number;
      recordedAt: Date;
      receivedAt: Date;
      isMapMatched: boolean;
      clientPointId: string;
    }[];
  }

  const generatedErrands: ErrandBatchData[] = [];
  let errandCounter = 0;

  const categoryNames = [
    "Fast Food & Restaurant",
    "Supermarket & Grocery",
    "Pharmacy & Health",
    "Bakery & Pastry",
    "Cafe",
    "Retail & General Merchandise",
  ];

  // Realistic rating feedback comments
  const positiveComments = [
    "Super fast and courteous rider! Kuya was very careful with the items.",
    "Arrived in 20 minutes! Food was still hot and packed well.",
    "Thank you Sugo Express! Very polite and professional rider.",
    "Carefully checked the expiration dates on the medicine. Salamat!",
    "Smooth transaction, exact change given with a smile.",
    "Delivered right to my doorstep even though it was raining.",
    "Accommodating rider, sent a message when he arrived at the store.",
    "Groceries were complete and fresh. Excellent service!",
    "5 stars! Best delivery service here in Tacurong City.",
    "Fast dispatch and friendly rider. Highly recommended!",
  ];

  // Realistic cancellation reasons
  const declineReasonsList = [
    "Store out of stock / closed early for scheduled maintenance",
    "Customer requested cancellation via chat due to change of schedule",
    "Delivery address temporarily outside operational road access corridor",
    "Severe localized thunderstorm delay requested by customer",
    "Item prices significantly altered at store shelf without customer consent",
  ];

  for (const plan of statusPlans) {
    for (let j = 0; j < plan.count; j++) {
      errandCounter++;
      const currentIdx = errandCounter;

      // Preserving showcase errand IDs 1..6 for deterministic test stability
      let errandId: string;
      if (currentIdx === 1) errandId = "e1111111-1111-4111-8111-111111111111";
      else if (currentIdx === 2) errandId = "e2222222-2222-4222-8222-222222222222";
      else if (currentIdx === 3) errandId = "e3333333-3333-4333-8333-333333333333";
      else if (currentIdx === 4) errandId = "e4444444-4444-4444-8444-444444444444";
      else if (currentIdx === 5) errandId = "e5555555-5555-4555-8555-555555555555";
      else if (currentIdx === 6) errandId = "e6666666-6666-4666-8666-666666666666";
      else errandId = `e0000000-0000-4000-8000-${String(currentIdx).padStart(12, "0")}`;

      // Pick category weighted realistically
      const catName = categoryNames[currentIdx % categoryNames.length];
      const primaryCatId = catMap.get(catName)!;
      const catPlaceList = categoryPlaces[catName] || places;
      const store1 = catPlaceList[currentIdx % catPlaceList.length];

      // Multi-store setup (15% of orders visit 2 stores)
      const isMultiStore = currentIdx % 7 === 0;
      const storeCount = isMultiStore ? 2 : 1;
      const store2 = isMultiStore ? places[(currentIdx + 3) % places.length] : null;

      // Customer assignment
      const customer = customerList[(currentIdx - 1) % customerList.length];
      const rider = plan.status === ErrandStatus.PENDING ? null : riders[(currentIdx - 1) % riders.length];
      const dispatcher = currentIdx % 2 === 0 ? dispatcher1 : dispatcher2;

      // Payment mode: 75% COD, 20% GCash, 5% Bank Transfer
      const paymentModeId = currentIdx % 20 === 0 ? bankModeId : currentIdx % 5 === 0 ? gcashModeId : codModeId;
      const paymentMethodName = paymentModeId === codModeId ? "COD" : paymentModeId === gcashModeId ? "GCash / PayMaya" : "Bank Transfer";

      // Date chronology
      let createdAt: Date;
      let assignedAt: Date | null = null;
      let acceptedAt: Date | null = null;
      let itemsPurchasedAt: Date | null = null;
      let deliveredAt: Date | null = null;
      let completedAt: Date | null = null;

      if (plan.status === ErrandStatus.COMPLETED) {
        // Spread across past 60 days
        const daysAgo = Math.floor((currentIdx / 400) * 58) + 1;
        const hourOfDay = 10 + (currentIdx % 11); // between 10am and 9pm
        const minuteOfHour = (currentIdx * 7) % 60;
        createdAt = new Date(now.getTime() - daysAgo * 24 * 3600 * 1000);
        createdAt.setHours(hourOfDay, minuteOfHour, 0, 0);

        assignedAt = new Date(createdAt.getTime() + 2 * 60 * 1000);
        acceptedAt = new Date(createdAt.getTime() + 4 * 60 * 1000);
        itemsPurchasedAt = new Date(createdAt.getTime() + (18 + (currentIdx % 10)) * 60 * 1000);
        deliveredAt = new Date(itemsPurchasedAt.getTime() + (15 + (currentIdx % 12)) * 60 * 1000);
        completedAt = new Date(deliveredAt.getTime() + 3 * 60 * 1000);
      } else if (plan.status === ErrandStatus.IN_TRANSIT) {
        // Active in past 30-75 minutes
        const minsAgo = 30 + (currentIdx % 45);
        createdAt = new Date(now.getTime() - minsAgo * 60 * 1000);
        assignedAt = new Date(createdAt.getTime() + 2 * 60 * 1000);
        acceptedAt = new Date(createdAt.getTime() + 4 * 60 * 1000);
        itemsPurchasedAt = new Date(createdAt.getTime() + 18 * 60 * 1000);
      } else if (plan.status === ErrandStatus.ASSIGNED) {
        // Assigned in past 10-30 minutes
        const minsAgo = 10 + (currentIdx % 20);
        createdAt = new Date(now.getTime() - minsAgo * 60 * 1000);
        assignedAt = new Date(createdAt.getTime() + 2 * 60 * 1000);
        acceptedAt = new Date(createdAt.getTime() + 4 * 60 * 1000);
      } else if (plan.status === ErrandStatus.PENDING) {
        // Fresh order in dispatch queue in past 2-25 minutes
        const minsAgo = 2 + (currentIdx % 23);
        createdAt = new Date(now.getTime() - minsAgo * 60 * 1000);
      } else {
        // CANCELLED in past 14 days
        const daysAgo = (currentIdx % 14) + 1;
        createdAt = new Date(now.getTime() - daysAgo * 24 * 3600 * 1000);
      }

      // Generate items for this errand (1 to 3 items)
      const catItems = itemCatalog[catName] || itemCatalog["Fast Food & Restaurant"];
      const itemCount = (currentIdx % 3) + 1;
      const errandItems: ErrandBatchData["items"] = [];
      let itemsEstimatedCost = 0;

      for (let k = 0; k < itemCount; k++) {
        const itemTemplate = catItems[(currentIdx + k) % catItems.length];
        const qty = k === 0 && currentIdx % 4 === 0 ? 2 : 1;
        const subtotal = itemTemplate.price * qty;
        itemsEstimatedCost += subtotal;

        let itemStatus = "COMPLETED";
        if (plan.status === ErrandStatus.IN_TRANSIT) itemStatus = "PURCHASED";
        else if (plan.status === ErrandStatus.ASSIGNED || plan.status === ErrandStatus.PENDING) itemStatus = "PENDING";
        else if (plan.status === ErrandStatus.CANCELLED) itemStatus = "CANCELLED";

        errandItems.push({
          errandId,
          sequence: 0,
          itemName: itemTemplate.name,
          storeCategory: catName,
          quantity: qty,
          size: itemTemplate.size,
          notes: itemTemplate.notes,
          unitPrice: itemTemplate.price,
          estimatedSubtotal: subtotal,
          fulfillmentStatus: itemStatus,
          createdAt,
        });
      }

      // If multi-store, add 1 item from store2
      if (store2) {
        const cat2Name = "Pharmacy & Health";
        const cat2Items = itemCatalog[cat2Name];
        const itemTemplate2 = cat2Items[currentIdx % cat2Items.length];
        const subtotal2 = itemTemplate2.price;
        itemsEstimatedCost += subtotal2;

        let itemStatus = "COMPLETED";
        if (plan.status === ErrandStatus.IN_TRANSIT) itemStatus = "PURCHASED";
        else if (plan.status === ErrandStatus.ASSIGNED || plan.status === ErrandStatus.PENDING) itemStatus = "PENDING";
        else if (plan.status === ErrandStatus.CANCELLED) itemStatus = "CANCELLED";

        errandItems.push({
          errandId,
          sequence: 1,
          itemName: itemTemplate2.name,
          storeCategory: cat2Name,
          quantity: 1,
          size: itemTemplate2.size,
          notes: itemTemplate2.notes,
          unitPrice: itemTemplate2.price,
          estimatedSubtotal: subtotal2,
          fulfillmentStatus: itemStatus,
          createdAt,
        });
      }

      // Fee computation
      const distanceKm = Number((1.2 + ((currentIdx * 37) % 35) / 10).toFixed(1)); // 1.2km to 4.6km
      const multiStoreFee = storeCount > 1 ? 30.0 : 0.0;
      const distanceFee = distanceKm > 2.0 ? Math.round((distanceKm - 2.0) * 10) : 0.0;
      const baseFee = 50.0;
      const deliveryFee = baseFee + multiStoreFee + distanceFee;
      const tip = plan.status === ErrandStatus.COMPLETED && currentIdx % 4 === 0 ? 20.0 : 0.0;
      const totalCost = itemsEstimatedCost + deliveryFee + tip;

      // Pinpoints for this errand
      const errandPinpoints: ErrandBatchData["pinpoints"] = [
        {
          errandId,
          sequence: 0,
          storeName: store1.name,
          latitude: store1.latitude,
          longitude: store1.longitude,
          categoryId: store1.categoryId,
          placeId: placeMap.get(store1.name) || null,
          arrivedAt: plan.status === ErrandStatus.COMPLETED || plan.status === ErrandStatus.IN_TRANSIT ? new Date(createdAt.getTime() + 10 * 60 * 1000) : null,
          departedAt: plan.status === ErrandStatus.COMPLETED || plan.status === ErrandStatus.IN_TRANSIT ? new Date(createdAt.getTime() + 20 * 60 * 1000) : null,
          legDistanceMeters: Math.round(distanceKm * 500),
          legDurationSeconds: Math.round(distanceKm * 90),
          createdAt,
        },
      ];

      if (store2) {
        errandPinpoints.push({
          errandId,
          sequence: 1,
          storeName: store2.name,
          latitude: store2.latitude,
          longitude: store2.longitude,
          categoryId: store2.categoryId,
          placeId: placeMap.get(store2.name) || null,
          arrivedAt: plan.status === ErrandStatus.COMPLETED || plan.status === ErrandStatus.IN_TRANSIT ? new Date(createdAt.getTime() + 25 * 60 * 1000) : null,
          departedAt: plan.status === ErrandStatus.COMPLETED || plan.status === ErrandStatus.IN_TRANSIT ? new Date(createdAt.getTime() + 32 * 60 * 1000) : null,
          legDistanceMeters: Math.round(distanceKm * 600),
          legDurationSeconds: Math.round(distanceKm * 100),
          createdAt,
        });
      }

      // Customer transaction
      let txStatus = "PAID";
      let txPaidAt: Date | null = completedAt;
      if (plan.status === ErrandStatus.IN_TRANSIT || plan.status === ErrandStatus.ASSIGNED || plan.status === ErrandStatus.PENDING) {
        txStatus = "PENDING";
        txPaidAt = null;
      } else if (plan.status === ErrandStatus.CANCELLED) {
        txStatus = "CANCELLED";
        txPaidAt = null;
      }

      const transaction: ErrandBatchData["transaction"] = {
        customerId: customer.id,
        errandId,
        amount: totalCost,
        paymentMethod: paymentMethodName,
        status: txStatus,
        paidAt: txPaidAt,
        createdAt,
      };

      // Payment Selection
      const paymentSelection: ErrandBatchData["paymentSelection"] = {
        id: crypto.randomUUID(),
        errandId,
        paymentModeId,
        confirmedAt: createdAt,
      };

      // Dispatch Log
      let dispatchLog: ErrandBatchData["dispatchLog"] = null;
      if (plan.status !== ErrandStatus.PENDING) {
        dispatchLog = {
          errandId,
          dispatcherId: dispatcher.id,
          notes: `Verified order details and store availability with customer ${customer.username}`,
          dispatchedAt: assignedAt || createdAt,
          verifiedAt: acceptedAt || createdAt,
        };
      }

      // Settlement record (for COMPLETED)
      let settlement: ErrandBatchData["settlement"] = null;
      if (plan.status === ErrandStatus.COMPLETED && rider) {
        const isShort = currentIdx % 25 === 0; // 4% short variance cases
        const variance = isShort ? -20.0 : 0.0;
        settlement = {
          errandId,
          riderId: rider.id,
          expectedAmount: totalCost,
          collectedAmount: totalCost + variance,
          variance,
          status: isShort ? "SHORT" : "RECONCILED",
          shortReason: isShort ? "Customer was short ₱20 on final door cash, promised to settle on next errand." : null,
          settledAt: completedAt!,
        };
      }

      // Rider Commission (for COMPLETED)
      let commission: ErrandBatchData["commission"] = null;
      if (plan.status === ErrandStatus.COMPLETED && rider) {
        commission = {
          errandId,
          riderId: rider.id,
          deliveryFee,
          tip,
          commissionRate: 0.8,
          riderShare: Number((deliveryFee * 0.8 + tip).toFixed(2)),
          businessShare: Number((deliveryFee * 0.2).toFixed(2)),
          itemCostExcluded: itemsEstimatedCost,
          computedAt: completedAt!,
        };
      }

      // Customer Rating (75% of completed errands)
      let rating: ErrandBatchData["rating"] = null;
      if (plan.status === ErrandStatus.COMPLETED && rider && currentIdx % 4 !== 0) {
        const stars = currentIdx % 10 === 0 ? 4 : 5;
        const comment = positiveComments[currentIdx % positiveComments.length];
        rating = {
          errandId,
          riderId: rider.id,
          stars,
          comment,
          createdAt: new Date(completedAt!.getTime() + 10 * 60 * 1000),
        };
      }

      // Decline Reason (for CANCELLED)
      let declineReason: ErrandBatchData["declineReason"] = null;
      if (plan.status === ErrandStatus.CANCELLED) {
        declineReason = {
          errandId,
          dispatcherId: dispatcher.id,
          reason: declineReasonsList[currentIdx % declineReasonsList.length],
          isCustom: false,
          createdAt: new Date(createdAt.getTime() + 12 * 60 * 1000),
        };
      }

      // Breadcrumb Track Points (for IN_TRANSIT and showcase completed)
      const trackPoints: ErrandBatchData["trackPoints"] = [];
      if (plan.status === ErrandStatus.IN_TRANSIT && rider) {
        trackPoints.push(
          {
            errandId,
            riderId: rider.id,
            latitude: store1.latitude,
            longitude: store1.longitude,
            accuracyMeters: 4.0,
            speedMps: 6.8,
            headingDeg: 80.0,
            recordedAt: new Date(now.getTime() - 8 * 60 * 1000),
            receivedAt: new Date(now.getTime() - 7 * 60 * 1000),
            isMapMatched: true,
            clientPointId: crypto.randomUUID(),
          },
          {
            errandId,
            riderId: rider.id,
            latitude: (store1.latitude + customer.defaultLoc.lat) / 2,
            longitude: (store1.longitude + customer.defaultLoc.lng) / 2,
            accuracyMeters: 3.8,
            speedMps: 8.5,
            headingDeg: 45.0,
            recordedAt: new Date(now.getTime() - 4 * 60 * 1000),
            receivedAt: new Date(now.getTime() - 3 * 60 * 1000),
            isMapMatched: true,
            clientPointId: crypto.randomUUID(),
          }
        );
      }

      const errandRecord = {
        id: errandId,
        category: catName,
        description: `Order from ${store1.name}${store2 ? ` & ${store2.name}` : ""}`,
        pickupAddress: `${store1.name}${store2 ? ` & ${store2.name}` : ""}`,
        deliveryAddress: customer.defaultLoc.address,
        deliveryLatitude: customer.defaultLoc.lat,
        deliveryLongitude: customer.defaultLoc.lng,
        deliveryStreetName: customer.defaultLoc.street,
        deliveryLandmark: customer.defaultLoc.landmark,
        deliveryNotes: customer.defaultLoc.notes,
        estimatedCost: itemsEstimatedCost,
        deliveryFee,
        tip,
        totalCost,
        status: plan.status,
        storeCount,
        customerId: customer.id,
        riderId: rider ? rider.id : null,
        paymentModeId,
        paymentEnabledAt: plan.status !== ErrandStatus.PENDING ? createdAt : null,
        paymentEnabledByDispatcherId: plan.status !== ErrandStatus.PENDING ? dispatcher.id : null,
        itemsPurchasedAt,
        assignedAt,
        acceptedAt,
        deliveredAt,
        completedAt,
        distanceKm,
        routeDistanceMeters: Math.round(distanceKm * 1000),
        routeDurationSeconds: Math.round(distanceKm * 180),
        routeProvider: "osrm",
        multiStoreFee,
        groceryFee: 0.0,
        nonCodFee: 0.0,
        distanceFee,
        feeCalculatedAt: createdAt,
        quotedHandlingBasket: itemsEstimatedCost,
        quotedHandlingFee: 0.0,
        quotedDeliveryFee: deliveryFee,
        etaLowAt: new Date(createdAt.getTime() + 30 * 60 * 1000),
        etaHighAt: new Date(createdAt.getTime() + 50 * 60 * 1000),
        etaComputedAt: createdAt,
        createdAt,
        updatedAt: completedAt || deliveredAt || itemsPurchasedAt || assignedAt || createdAt,
      };

      generatedErrands.push({
        errand: errandRecord,
        pinpoints: errandPinpoints,
        items: errandItems,
        transaction,
        paymentSelection,
        dispatchLog,
        settlement,
        commission,
        rating,
        declineReason,
        trackPoints,
      });
    }
  }

  console.log(`   ✔ Generated in-memory structures for ${generatedErrands.length} errands.`);

  // =========================================================================
  // 5b. DETERMINISTIC CLEANUP & FAST BULK INSERTIONS
  // =========================================================================
  console.log("⚡ Phase 5b: Executing High-Speed Bulk Cleanups & Insertions...");

  const allErrandIds = generatedErrands.map((g) => g.errand.id);

  // Bulk cleanup of previous errand instances
  console.log("   - Cleaning up previous errand relations...");
  await prisma.customerTransaction.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.settlementRecord.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.rating.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.riderCommission.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.errandProofImage.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.errandPayment.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.paymentSelection.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.dispatchLog.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.errandDeclineReason.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.exceptionReview.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.dwellObservation.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.errandTrackPoint.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.pabiliDetail.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.pabiliItemRequest.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.errandPinpoint.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.connectivityIncident.deleteMany({ where: { errandId: { in: allErrandIds } } });
  await prisma.errand.deleteMany({ where: { id: { in: allErrandIds } } });

  // Bulk insert Errands in chunks of 250
  console.log("   - Bulk inserting 500 errands...");
  const rawErrands = generatedErrands.map((g) => g.errand);
  await chunkedCreateMany(rawErrands, 250, (chunk) => prisma.errand.createMany({ data: chunk }));

  // Bulk insert Pinpoints
  console.log("   - Bulk inserting store pinpoints...");
  const rawPinpoints = generatedErrands.flatMap((g) => g.pinpoints);
  await chunkedCreateMany(rawPinpoints, 250, (chunk) => prisma.errandPinpoint.createMany({ data: chunk }));

  // Fetch created pinpoint IDs to link working items and dwell observations
  console.log("   - Resolving pinpoint IDs for item relations...");
  const createdPins = await prisma.errandPinpoint.findMany({
    where: { errandId: { in: allErrandIds } },
    select: { id: true, errandId: true, sequence: true },
  });
  const pinLookup = new Map<string, number>();
  for (const pin of createdPins) {
    pinLookup.set(`${pin.errandId}_${pin.sequence}`, pin.id);
  }

  // Bulk insert Working Items (pabili_details_tbl)
  console.log("   - Bulk inserting itemized pabili details...");
  const rawWorkingItems = generatedErrands.flatMap((g) =>
    g.items.map((it) => ({
      errandId: it.errandId,
      itemName: it.itemName,
      storeCategory: it.storeCategory,
      quantity: it.quantity,
      size: it.size,
      notes: it.notes,
      unitPrice: it.unitPrice,
      estimatedSubtotal: it.estimatedSubtotal,
      fulfillmentStatus: it.fulfillmentStatus,
      pinpointId: pinLookup.get(`${it.errandId}_${it.sequence}`) || null,
      createdAt: it.createdAt,
    }))
  );
  await chunkedCreateMany(rawWorkingItems, 300, (chunk) => prisma.pabiliDetail.createMany({ data: chunk }));

  // Bulk insert Immutable Item Requests (pabili_item_requests_tbl)
  console.log("   - Bulk inserting customer item requests audit trail...");
  const rawItemRequests = generatedErrands.flatMap((g) =>
    g.items.map((it) => ({
      errandId: it.errandId,
      itemName: it.itemName,
      storeCategory: it.storeCategory,
      quantity: it.quantity,
      size: it.size,
      notes: it.notes,
      pinpointId: pinLookup.get(`${it.errandId}_${it.sequence}`) || null,
      createdAt: it.createdAt,
    }))
  );
  await chunkedCreateMany(rawItemRequests, 300, (chunk) => prisma.pabiliItemRequest.createMany({ data: chunk }));

  // Bulk insert Customer Transactions (500 rows)
  console.log("   - Bulk inserting 500 customer transactions...");
  const rawTransactions = generatedErrands.map((g) => g.transaction);
  await chunkedCreateMany(rawTransactions, 250, (chunk) => prisma.customerTransaction.createMany({ data: chunk }));

  // Bulk insert Payment Selections
  console.log("   - Bulk inserting payment selections...");
  const rawPaymentSelections = generatedErrands.map((g) => g.paymentSelection);
  await chunkedCreateMany(rawPaymentSelections, 250, (chunk) => prisma.paymentSelection.createMany({ data: chunk }));

  // Bulk insert Dispatch Logs
  console.log("   - Bulk inserting dispatch logs...");
  const rawDispatchLogs = generatedErrands.map((g) => g.dispatchLog).filter((log): log is NonNullable<typeof log> => log !== null);
  await chunkedCreateMany(rawDispatchLogs, 250, (chunk) => prisma.dispatchLog.createMany({ data: chunk }));

  // Bulk insert Settlement Records (~400 rows)
  console.log("   - Bulk inserting cash settlement reconciliation records...");
  const rawSettlements = generatedErrands.map((g) => g.settlement).filter((s): s is NonNullable<typeof s> => s !== null);
  await chunkedCreateMany(rawSettlements, 250, (chunk) => prisma.settlementRecord.createMany({ data: chunk }));

  // Bulk insert Rider Commissions (~400 rows)
  console.log("   - Bulk inserting rider commission payroll records...");
  const rawCommissions = generatedErrands.map((g) => g.commission).filter((c): c is NonNullable<typeof c> => c !== null);
  await chunkedCreateMany(rawCommissions, 250, (chunk) => prisma.riderCommission.createMany({ data: chunk }));

  // Bulk insert Ratings (~300 rows)
  console.log("   - Bulk inserting verified customer ratings...");
  const rawRatings = generatedErrands.map((g) => g.rating).filter((r): r is NonNullable<typeof r> => r !== null);
  await chunkedCreateMany(rawRatings, 250, (chunk) => prisma.rating.createMany({ data: chunk }));

  // Bulk insert Dwell Observations (for dwell learning)
  console.log("   - Bulk inserting dwell observations for ETA machine learning...");
  const rawDwells = generatedErrands
    .filter((g) => g.errand.status === ErrandStatus.COMPLETED)
    .flatMap((g) =>
      g.pinpoints.map((p) => ({
        errandId: g.errand.id,
        pinpointId: pinLookup.get(`${g.errand.id}_${p.sequence}`)!,
        categoryId: p.categoryId,
        placeId: p.placeId,
        dwellSeconds: 300 + (Math.abs(p.latitude * 1000) % 600),
        arrivedAt: p.arrivedAt!,
        departedAt: p.departedAt!,
        stalled: false,
        createdAt: p.arrivedAt!,
      }))
    )
    .filter((d) => d.pinpointId != null);
  await chunkedCreateMany(rawDwells, 250, (chunk) => prisma.dwellObservation.createMany({ data: chunk }));

  // Bulk insert Track Points
  console.log("   - Bulk inserting live breadcrumb GPS track points...");
  const rawTrackPoints = generatedErrands.flatMap((g) => g.trackPoints);
  await chunkedCreateMany(rawTrackPoints, 250, (chunk) => prisma.errandTrackPoint.createMany({ data: chunk }));

  // Bulk insert Decline Reasons
  console.log("   - Bulk inserting dispatcher decline reasons for cancelled errands...");
  const rawDeclineReasons = generatedErrands.map((g) => g.declineReason).filter((dr): dr is NonNullable<typeof dr> => dr !== null);
  await chunkedCreateMany(rawDeclineReasons, 250, (chunk) => prisma.errandDeclineReason.createMany({ data: chunk }));

  // Showcase Errand 2 Cash Variance Exception Review
  await prisma.exceptionReview.create({
    data: {
      errandId: "e2222222-2222-4222-8222-222222222222",
      kind: "CASH_VARIANCE",
      reviewerId: dispatcher1.id,
      reason: "Customer sent remaining ₱20 credit via GCash top-up; cash drawer balanced.",
      amountAtRisk: 20.0,
      resolvedAt: new Date(now.getTime() - 2 * 3600 * 1000),
    },
  });

  // Showcase Errand 2 Upfront and Final Errand Payments
  await prisma.errandPayment.createMany({
    data: [
      {
        id: crypto.randomUUID(),
        errandId: "e2222222-2222-4222-8222-222222222222",
        kind: ErrandPaymentKind.UPFRONT,
        amount: 425.0,
        confirmedByUserId: dispatcher1.id,
        confirmedAt: new Date(now.getTime() - 3 * 3600 * 1000),
        note: "50% upfront GCash payment received on FB Page (Ref: GC-998822)",
      },
      {
        id: crypto.randomUUID(),
        errandId: "e2222222-2222-4222-8222-222222222222",
        kind: ErrandPaymentKind.FINAL,
        amount: 495.0,
        confirmedByUserId: dispatcher1.id,
        confirmedAt: new Date(now.getTime() - 2 * 3600 * 1000),
        note: "Final remaining balance collected at door",
      },
    ],
  });

  console.log("   ✔ 500 Errands and all associated relational records seeded successfully!\n");

  // =========================================================================
  // 6. SYSTEM AUDIT, FEEDBACK, NOTIFICATIONS & SECURITY TELEMETRY
  // =========================================================================
  console.log("📊 Phase 6: Seeding Audit Trail, Customer Feedback, Notifications & Security...");

  const anaCustomer = customerList.find((c) => c.username === "customer_ana")!;
  const markCustomer = customerList.find((c) => c.username === "customer_mark")!;

  // Customer Feedback
  await prisma.customerFeedback.deleteMany({
    where: { refCode: { in: ["FB-261015-0001", "FB-261015-0002", "FB-261015-0003"] } },
  });

  await prisma.customerFeedback.createMany({
    data: [
      {
        refCode: "FB-261015-0001",
        customerId: anaCustomer.id,
        category: FeedbackCategory.BUG_REPORT,
        rating: 4,
        subject: "Map pin snapping near Public Market",
        message: "When pinning Lapu-Lapu street near the market, the map initially snapped to the rear alleyway. I had to manually write notes.",
        status: FeedbackStatus.RESOLVED,
        readAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        readByUserId: owner.id,
        developerNotes: "Road centerline snapping algorithm updated with widened 25m corridor radius.",
        resolvedAt: new Date(now.getTime() - 1 * 60 * 60 * 1000),
        emailDispatched: true,
      },
      {
        refCode: "FB-261015-0002",
        customerId: markCustomer.id,
        category: FeedbackCategory.DELIVERY_EXPERIENCE,
        rating: 5,
        subject: "Kuya Pedro was very polite and punctual",
        message: "Arrived in 25 minutes during dinner rush hour! Everything was packed securely and hot.",
        status: FeedbackStatus.NEW,
        emailDispatched: true,
      },
      {
        refCode: "FB-261015-0003",
        customerId: customerList[4].id,
        category: FeedbackCategory.FEATURE_REQUEST,
        rating: 5,
        subject: "Schedule orders for the morning",
        message: "Would love to be able to schedule breakfast bakeshop orders the night before!",
        status: FeedbackStatus.IN_REVIEW,
        emailDispatched: false,
      },
    ],
  });

  // Notifications
  await prisma.notification.deleteMany({
    where: {
      title: {
        in: [
          "Welcome to Sugo Express!",
          "Order Completed: Jollibee Tacurong",
          "New Dispatch Assignment Available",
        ],
      },
    },
  });

  await prisma.notification.createMany({
    data: [
      {
        customerId: anaCustomer.id,
        type: "WELCOME",
        title: "Welcome to Sugo Express!",
        body: "Your account is active. Enjoy seamless Pabili and errands across Tacurong City!",
        isRead: true,
      },
      {
        customerId: anaCustomer.id,
        type: "ORDER_STATUS",
        title: "Order Completed: Jollibee Tacurong",
        body: "Your errand has been successfully delivered by rider Pedro Penduko. Thank you!",
        isRead: false,
      },
      {
        userId: riders[0].id,
        type: "DISPATCH_OFFER",
        title: "New Dispatch Assignment Available",
        body: "New errand waiting near Alunan Highway. Open your Rider Console to review.",
        isRead: true,
      },
    ],
  });

  // Connectivity Incidents
  await prisma.connectivityIncident.create({
    data: {
      riderId: riders[1].id,
      errandId: "e2222222-2222-4222-8222-222222222222",
      disconnectedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
      reconnectedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000 - 56 * 60 * 1000),
    },
  });

  // Account Login Logs
  await prisma.accountLoginLog.createMany({
    data: [
      {
        userId: owner.id,
        role: "OWNER",
        ipAddress: "127.0.0.1",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0",
        deviceInfo: "Chrome on Windows",
        status: "SUCCESS",
        isOnline: true,
      },
      {
        userId: dispatcher1.id,
        role: "DISPATCHER",
        ipAddress: "127.0.0.1",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0",
        deviceInfo: "Chrome on Windows (Dispatcher Console)",
        status: "SUCCESS",
        isOnline: true,
      },
      {
        userId: riders[0].id,
        role: "RIDER",
        ipAddress: "120.29.74.12",
        userAgent: "Expo/57.0.0 (Android 14; SM-A045F)",
        deviceInfo: "Samsung Galaxy A04",
        status: "SUCCESS",
        isOnline: true,
      },
    ],
  });

  // Staff Known Devices
  await prisma.userKnownDevice.upsert({
    where: {
      userId_deviceId: {
        userId: owner.id,
        deviceId: "dev_desk_owner_01",
      },
    },
    update: { lastSeenAt: new Date() },
    create: {
      userId: owner.id,
      deviceId: "dev_desk_owner_01",
      deviceInfo: "Windows 11 Workstation",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      ipAddress: "127.0.0.1",
    },
  });

  // IP Whitelist & Threat Defense
  await prisma.whitelistedIp.upsert({
    where: { ipAddress: "127.0.0.1" },
    update: { isImmune: true },
    create: {
      ipAddress: "127.0.0.1",
      description: "Localhost Developer Loopback",
      isImmune: true,
    },
  });

  const blockedIpCheck = await prisma.blockedIp.findFirst({
    where: { ipAddress: "198.51.100.44" },
  });
  if (!blockedIpCheck) {
    await prisma.blockedIp.create({
      data: {
        ipAddress: "198.51.100.44",
        reason: "Excessive failed sign-in attempts on admin endpoint",
        banType: BanType.AUTOMATIC,
        severity: ThreatSeverity.HIGH,
        status: BanStatus.ACTIVE,
        attackCount: 12,
      },
    });
  }
  console.log("   ✔ Seeded Customer Feedback, Notifications, Logs, and Security Whitelist.\n");

  // =========================================================================
  // SUMMARY & VERIFICATION
  // =========================================================================
  const totalErrands = await prisma.errand.count();
  const totalTransactions = await prisma.customerTransaction.count();
  const totalCustomers = await prisma.customerAccount.count();
  const totalStaff = await prisma.user.count();
  const totalWorkingItems = await prisma.pabiliDetail.count();
  const totalSettlements = await prisma.settlementRecord.count();
  const totalCommissions = await prisma.riderCommission.count();
  const totalRatings = await prisma.rating.count();
  const totalDwells = await prisma.dwellObservation.count();
  const totalPinpoints = await prisma.errandPinpoint.count();

  console.log("=========================================================");
  console.log("✅ 500-RECORD DATABASE SEEDING COMPLETED WITH ZERO ERRORS! 🎉");
  console.log("=========================================================");
  console.log(`- Operational Staff Members: ${totalStaff}`);
  console.log(`- Customer Accounts:         ${totalCustomers}`);
  console.log(`- Total Errands:             ${totalErrands}`);
  console.log(`- Customer Transactions:     ${totalTransactions}`);
  console.log(`- Itemized Pabili Details:   ${totalWorkingItems}`);
  console.log(`- Store Pinpoints:           ${totalPinpoints}`);
  console.log(`- Cash Settlements:          ${totalSettlements}`);
  console.log(`- Rider Commissions:         ${totalCommissions}`);
  console.log(`- Customer Ratings:          ${totalRatings}`);
  console.log(`- Dwell Observations:        ${totalDwells}`);
  console.log(`- Verified Establishments:   ${await prisma.verifiedPlace.count()}`);
  console.log("---------------------------------------------------------");
  console.log("🔑 TEST LOGINS (passwords are the ones you set in the environment):");
  console.log("   OWNER:       username: owner         | pass: $OWNER_SEED_PASSWORD");
  console.log("   DISPATCHER:  username: dispatcher1   | pass: $STAFF_SEED_PASSWORD");
  console.log("   DISPATCHER:  username: dispatcher2   | pass: $STAFF_SEED_PASSWORD");
  console.log("   RIDER:       username: rider1        | pass: $STAFF_SEED_PASSWORD");
  console.log("   RIDER:       username: rider2        | pass: $STAFF_SEED_PASSWORD");
  console.log("   RIDER:       username: rider3        | pass: $STAFF_SEED_PASSWORD");
  console.log("   CUSTOMER:    username: customer_ana  | pass: $CUSTOMER_SEED_PASSWORD");
  console.log("   CUSTOMER:    username: customer_mark | pass: $CUSTOMER_SEED_PASSWORD");
  console.log("   SYSADMIN IT: username: sysadminit    | pass: $SYSADMIN_SEED_PASSWORD");
  console.log("=========================================================\n");
}

main()
  .catch((e) => {
    console.error("❌ Fatal Seeding Failure:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
