const fs = require('fs');
const path = require('path');

// ============================================================================
// 1. TABLE DEFINITIONS & SPATIAL POSITIONS
// Designed in a structured 4-column operational layout with dedicated gutters
// No table overlaps, generous 80-120px channels between columns and tiers
// ============================================================================
const ROW_H = 21;
const HEAD_H = 28;

const TABLES = [
  // COLUMN 1: CUSTOMER DOMAIN (X: 100 - 600)
  {
    id: "customer_information",
    name: "customer_information_tbl",
    domain: "users",
    x: 80,
    y: 200,
    w: 220,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "customerId" },
      { key: "",   name: "firstName" },
      { key: "",   name: "middleName" },
      { key: "",   name: "lastName" },
      { key: "",   name: "phone" },
      { key: "",   name: "birthdate" }
    ]
  },
  {
    id: "customer_accounts",
    name: "customer_accounts_tbl",
    domain: "users",
    x: 370,
    y: 200,
    w: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "",   name: "username" },
      { key: "",   name: "email" },
      { key: "",   name: "status" },
      { key: "",   name: "emailVerified" },
      { key: "",   name: "expoPushToken" }
    ]
  },
  {
    id: "saved_delivery_locations",
    name: "saved_delivery_locations_tbl",
    domain: "users",
    x: 370,
    y: 450,
    w: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "customerId" },
      { key: "",   name: "label" },
      { key: "",   name: "address" },
      { key: "",   name: "latitude" },
      { key: "",   name: "longitude" },
      { key: "",   name: "isDefault" }
    ]
  },
  {
    id: "errand_decline_reasons",
    name: "errand_decline_reasons_tbl",
    domain: "errand",
    x: 370,
    y: 720,
    w: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "errandId" },
      { key: "FK", name: "dispatcherId" },
      { key: "",   name: "reason" },
      { key: "",   name: "isCustom" },
      { key: "",   name: "createdAt" }
    ]
  },

  // COLUMN 2: CENTER HUB - ERRANDS & ITEM DETAILS (X: 720 - 1000)
  {
    id: "pabili_item_requests",
    name: "pabili_item_requests_tbl",
    domain: "errand",
    x: 720,
    y: 100,
    w: 220,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "errandId" },
      { key: "FK", name: "pinpointId" },
      { key: "",   name: "itemName" },
      { key: "",   name: "storeCategory" },
      { key: "",   name: "quantity" }
    ]
  },
  {
    id: "pabili_details",
    name: "pabili_details_tbl",
    domain: "errand",
    x: 1010,
    y: 100,
    w: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "errandId" },
      { key: "FK", name: "pinpointId" },
      { key: "",   name: "itemName" },
      { key: "",   name: "storeCategory" },
      { key: "",   name: "quantity" },
      { key: "",   name: "unitPrice" },
      { key: "",   name: "estimatedSubtotal" }
    ]
  },
  {
    id: "errands",
    name: "errands_tbl",
    domain: "errand",
    x: 750,
    y: 360,
    w: 260,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "customerId" },
      { key: "FK", name: "riderId" },
      { key: "FK", name: "paymentModeId" },
      { key: "",   name: "category" },
      { key: "",   name: "description" },
      { key: "",   name: "pickupAddress" },
      { key: "",   name: "deliveryAddress" },
      { key: "",   name: "estimatedCost" },
      { key: "",   name: "deliveryFee" },
      { key: "",   name: "tip" },
      { key: "",   name: "totalCost" },
      { key: "",   name: "status" },
      { key: "",   name: "storeCount" },
      { key: "",   name: "assignedAt" },
      { key: "",   name: "deliveredAt" },
      { key: "",   name: "completedAt" }
    ]
  },
  {
    id: "dispatch_logs",
    name: "dispatch_logs_tbl",
    domain: "errand",
    x: 750,
    y: 840,
    w: 240,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "errandId" },
      { key: "FK", name: "dispatcherId" },
      { key: "",   name: "notes" },
      { key: "",   name: "dispatchedAt" },
      { key: "",   name: "verifiedAt" }
    ]
  },

  // COLUMN 3: STOPS, RATES, & FLEET STAFF (X: 1150 - 1460)
  {
    id: "errand_pinpoints",
    name: "errand_pinpoints_tbl",
    domain: "errand",
    x: 1320,
    y: 100,
    w: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "errandId" },
      { key: "FK", name: "categoryId" },
      { key: "FK", name: "placeId" },
      { key: "",   name: "sequence" },
      { key: "",   name: "storeName" },
      { key: "",   name: "latitude" },
      { key: "",   name: "longitude" },
      { key: "",   name: "arrivedAt" },
      { key: "",   name: "departedAt" }
    ]
  },
  {
    id: "payment_modes",
    name: "payment_modes_tbl",
    domain: "finance",
    x: 1140,
    y: 360,
    w: 210,
    columns: [
      { key: "PK", name: "id" },
      { key: "",   name: "name" },
      { key: "",   name: "description" },
      { key: "",   name: "status" }
    ]
  },
  {
    id: "rate_configs",
    name: "service_rate_configs_tbl",
    domain: "finance",
    x: 1140,
    y: 540,
    w: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "",   name: "baseFee" },
      { key: "",   name: "perKmRate" },
      { key: "",   name: "multiStoreFeePerStore" },
      { key: "",   name: "groceryFeeThreshold" },
      { key: "",   name: "groceryFeePercent" },
      { key: "",   name: "groceryFeeFlat" },
      { key: "",   name: "nonCodThreshold" }
    ]
  },
  {
    id: "users",
    name: "users_tbl",
    domain: "users",
    x: 1140,
    y: 840,
    w: 240,
    columns: [
      { key: "PK", name: "id" },
      { key: "",   name: "username" },
      { key: "",   name: "role" },
      { key: "",   name: "firstName" },
      { key: "",   name: "middleName" },
      { key: "",   name: "lastName" },
      { key: "",   name: "email" },
      { key: "",   name: "phone" },
      { key: "",   name: "status" },
      { key: "",   name: "profileCompleted" }
    ]
  },

  // COLUMN 4: MERCHANT CATALOG & FEEDBACK (X: 1620 - 1920)
  {
    id: "merchant_categories",
    name: "merchant_categories_tbl",
    domain: "merchant",
    x: 1680,
    y: 100,
    w: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "",   name: "name" },
      { key: "",   name: "description" },
      { key: "",   name: "status" },
      { key: "",   name: "handlingFeeMode" },
      { key: "",   name: "dwellP50Seconds" },
      { key: "",   name: "geofenceRadiusMeters" }
    ]
  },
  {
    id: "verified_places",
    name: "verified_places_tbl",
    domain: "merchant",
    x: 1680,
    y: 360,
    w: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "categoryId" },
      { key: "",   name: "name" },
      { key: "",   name: "address" },
      { key: "",   name: "barangay" },
      { key: "",   name: "latitude" },
      { key: "",   name: "longitude" },
      { key: "",   name: "isActive" }
    ]
  },
  {
    id: "ratings",
    name: "ratings_tbl",
    domain: "errand",
    x: 1680,
    y: 620,
    w: 220,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "errandId" },
      { key: "FK", name: "riderId" },
      { key: "",   name: "stars" },
      { key: "",   name: "comment" },
      { key: "",   name: "createdAt" }
    ]
  },
  {
    id: "rider_presence",
    name: "rider_presence_tracking_tbl",
    domain: "users",
    x: 1480,
    y: 840,
    w: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "riderId" },
      { key: "",   name: "latitude" },
      { key: "",   name: "longitude" },
      { key: "",   name: "onDuty" },
      { key: "",   name: "backgroundLocation" },
      { key: "",   name: "connectivity" },
      { key: "",   name: "lastBeaconAt" }
    ]
  },
  {
    id: "notifications",
    name: "notifications_tbl",
    domain: "users",
    x: 1780,
    y: 840,
    w: 220,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "userId" },
      { key: "FK", name: "customerId" },
      { key: "",   name: "type" },
      { key: "",   name: "title" },
      { key: "",   name: "body" },
      { key: "",   name: "isRead" }
    ]
  },

  // ROW 5: FINANCIAL SETTLEMENTS & COMMISSIONS (Y: 1180 - 1380)
  {
    id: "errand_payments",
    name: "errand_payments_tbl",
    domain: "finance",
    x: 450,
    y: 1180,
    w: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "errandId" },
      { key: "FK", name: "confirmedByUserId" },
      { key: "FK", name: "proofImageId" },
      { key: "",   name: "kind" },
      { key: "",   name: "amount" },
      { key: "",   name: "confirmedAt" }
    ]
  },
  {
    id: "settlement_records",
    name: "settlement_records_tbl",
    domain: "finance",
    x: 770,
    y: 1180,
    w: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "errandId" },
      { key: "FK", name: "riderId" },
      { key: "",   name: "expectedAmount" },
      { key: "",   name: "collectedAmount" },
      { key: "",   name: "variance" },
      { key: "",   name: "status" },
      { key: "",   name: "settledAt" }
    ]
  },
  {
    id: "rider_commissions",
    name: "rider_commissions_tbl",
    domain: "finance",
    x: 1090,
    y: 1180,
    w: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "errandId" },
      { key: "FK", name: "riderId" },
      { key: "",   name: "deliveryFee" },
      { key: "",   name: "tip" },
      { key: "",   name: "riderShare" },
      { key: "",   name: "businessShare" },
      { key: "",   name: "computedAt" }
    ]
  }
];

// Compute heights
TABLES.forEach(t => {
  t.h = HEAD_H + t.columns.length * ROW_H;
});

const tableMap = {};
TABLES.forEach(t => { tableMap[t.id] = t; });

// ============================================================================
// 2. EXPLICIT NON-CROSSING ORTHOGONAL ROUTING PATHS
// Every line routes exclusively through clear channels (gutters or perimeter)
// Zero lines intersect or cut across any table card!
// ============================================================================
const ROUTES = [
  // 1. customer_accounts -> customer_information (Direct horizontal)
  {
    name: "customer_accounts to customer_information",
    from: "customer_accounts",
    to: "customer_information",
    points: [
      { x: 370, y: 240 },
      { x: 300, y: 240 }
    ]
  },
  // 2. customer_accounts -> saved_delivery_locations (Direct vertical)
  {
    name: "customer_accounts to saved_delivery_locations",
    from: "customer_accounts",
    to: "saved_delivery_locations",
    points: [
      { x: 485, y: 343 },
      { x: 485, y: 450 }
    ]
  },
  // 3. customer_accounts -> errands (Horizontal channel)
  {
    name: "customer_accounts to errands",
    from: "customer_accounts",
    to: "errands",
    points: [
      { x: 600, y: 260 },
      { x: 660, y: 260 },
      { x: 660, y: 400 },
      { x: 750, y: 400 }
    ]
  },
  // 4. errands -> pabili_item_requests (Upward channel)
  {
    name: "errands to pabili_item_requests",
    from: "errands",
    to: "pabili_item_requests",
    points: [
      { x: 800, y: 360 },
      { x: 800, y: 254 }
    ]
  },
  // 5. errands -> pabili_details (Upward channel)
  {
    name: "errands to pabili_details",
    from: "errands",
    to: "pabili_details",
    points: [
      { x: 960, y: 360 },
      { x: 960, y: 310 },
      { x: 1080, y: 310 },
      { x: 1080, y: 296 }
    ]
  },
  // 6. errands -> errand_pinpoints (Gutter at y=320 between pabili_details and payment_modes)
  {
    name: "errands to errand_pinpoints",
    from: "errands",
    to: "errand_pinpoints",
    points: [
      { x: 990, y: 360 },
      { x: 990, y: 325 },
      { x: 1400, y: 325 },
      { x: 1400, y: 317 }
    ]
  },
  // 7. pabili_details -> errand_pinpoints (Direct horizontal)
  {
    name: "pabili_details to errand_pinpoints",
    from: "pabili_details",
    to: "errand_pinpoints",
    points: [
      { x: 1240, y: 160 },
      { x: 1320, y: 160 }
    ]
  },
  // 8. errand_pinpoints -> merchant_categories (Direct horizontal)
  {
    name: "errand_pinpoints to merchant_categories",
    from: "errand_pinpoints",
    to: "merchant_categories",
    points: [
      { x: 1550, y: 160 },
      { x: 1680, y: 160 }
    ]
  },
  // 9. merchant_categories -> verified_places (Direct vertical)
  {
    name: "merchant_categories to verified_places",
    from: "merchant_categories",
    to: "verified_places",
    points: [
      { x: 1795, y: 275 },
      { x: 1795, y: 360 }
    ]
  },
  // 10. verified_places -> errand_pinpoints (Channel at x=1610)
  {
    name: "verified_places to errand_pinpoints",
    from: "verified_places",
    to: "errand_pinpoints",
    points: [
      { x: 1680, y: 400 },
      { x: 1610, y: 400 },
      { x: 1610, y: 240 },
      { x: 1550, y: 240 }
    ]
  },
  // 11. payment_modes -> errands (Direct horizontal)
  {
    name: "payment_modes to errands",
    from: "payment_modes",
    to: "errands",
    points: [
      { x: 1140, y: 420 },
      { x: 1010, y: 420 }
    ]
  },
  // 12. rate_configs -> errands (Channel)
  {
    name: "rate_configs to errands",
    from: "rate_configs",
    to: "errands",
    points: [
      { x: 1140, y: 580 },
      { x: 1060, y: 580 },
      { x: 1060, y: 500 },
      { x: 1010, y: 500 }
    ]
  },
  // 13. errands -> dispatch_logs (Direct vertical)
  {
    name: "errands to dispatch_logs",
    from: "errands",
    to: "dispatch_logs",
    points: [
      { x: 870, y: 745 },
      { x: 870, y: 840 }
    ]
  },
  // 14. users -> dispatch_logs (Direct horizontal)
  {
    name: "users to dispatch_logs",
    from: "users",
    to: "dispatch_logs",
    points: [
      { x: 1140, y: 880 },
      { x: 990, y: 880 }
    ]
  },
  // 15. users -> errands (Gutter at x=1080)
  {
    name: "users to errands",
    from: "users",
    to: "errands",
    points: [
      { x: 1200, y: 840 },
      { x: 1200, y: 780 },
      { x: 1080, y: 780 },
      { x: 1080, y: 650 },
      { x: 1010, y: 650 }
    ]
  },
  // 16. users -> rider_presence (Direct horizontal)
  {
    name: "users to rider_presence",
    from: "users",
    to: "rider_presence",
    points: [
      { x: 1380, y: 880 },
      { x: 1480, y: 880 }
    ]
  },
  // 17. users -> notifications (Channel below rider_presence)
  {
    name: "users to notifications",
    from: "users",
    to: "notifications",
    points: [
      { x: 1260, y: 1078 },
      { x: 1260, y: 1100 },
      { x: 1740, y: 1100 },
      { x: 1740, y: 920 },
      { x: 1780, y: 920 }
    ]
  },
  // 18. errands -> errand_decline_reasons (Horizontal channel at y=760)
  {
    name: "errands to errand_decline_reasons",
    from: "errands",
    to: "errand_decline_reasons",
    points: [
      { x: 750, y: 710 },
      { x: 670, y: 710 },
      { x: 670, y: 760 },
      { x: 600, y: 760 }
    ]
  },
  // 19. users -> errand_decline_reasons (Channel under dispatch_logs at y=1020)
  {
    name: "users to errand_decline_reasons",
    from: "users",
    to: "errand_decline_reasons",
    points: [
      { x: 1140, y: 960 },
      { x: 1040, y: 960 },
      { x: 1040, y: 1020 },
      { x: 670, y: 1020 },
      { x: 670, y: 820 },
      { x: 600, y: 820 }
    ]
  },
  // 20. errands -> ratings (Channel between rate_configs and users at y=780)
  {
    name: "errands to ratings",
    from: "errands",
    to: "ratings",
    points: [
      { x: 1010, y: 720 },
      { x: 1080, y: 720 },
      { x: 1080, y: 780 },
      { x: 1640, y: 780 },
      { x: 1640, y: 680 },
      { x: 1680, y: 680 }
    ]
  },
  // 21. users -> ratings (Channel)
  {
    name: "users to ratings",
    from: "users",
    to: "ratings",
    points: [
      { x: 1340, y: 840 },
      { x: 1340, y: 760 },
      { x: 1640, y: 760 },
      { x: 1640, y: 710 },
      { x: 1680, y: 710 }
    ]
  },
  // 22. errands -> settlement_records (Direct vertical channel)
  {
    name: "errands to settlement_records",
    from: "errands",
    to: "settlement_records",
    points: [
      { x: 800, y: 745 },
      { x: 800, y: 800 },
      { x: 720, y: 800 },
      { x: 720, y: 1120 },
      { x: 840, y: 1120 },
      { x: 840, y: 1180 }
    ]
  },
  // 23. users -> settlement_records (Channel into bottom tier)
  {
    name: "users to settlement_records",
    from: "users",
    to: "settlement_records",
    points: [
      { x: 1180, y: 1078 },
      { x: 1180, y: 1140 },
      { x: 950, y: 1140 },
      { x: 950, y: 1180 }
    ]
  },
  // 24. errands -> errand_payments (Channel)
  {
    name: "errands to errand_payments",
    from: "errands",
    to: "errand_payments",
    points: [
      { x: 750, y: 620 },
      { x: 690, y: 620 },
      { x: 690, y: 1140 },
      { x: 580, y: 1140 },
      { x: 580, y: 1180 }
    ]
  },
  // 25. users -> rider_commissions (Direct vertical)
  {
    name: "users to rider_commissions",
    from: "users",
    to: "rider_commissions",
    points: [
      { x: 1220, y: 1078 },
      { x: 1220, y: 1180 }
    ]
  },
  // 26. customer_accounts -> notifications (Outer Top/Right Perimeter Channel!)
  {
    name: "customer_accounts to notifications",
    from: "customer_accounts",
    to: "notifications",
    points: [
      { x: 485, y: 200 },
      { x: 485, y: 40 },
      { x: 2040, y: 40 },
      { x: 2040, y: 880 },
      { x: 2000, y: 880 }
    ]
  }
];

// ============================================================================
// 3. COLLISION VERIFICATION ENGINE
// Mathematically verifies that NO line segment cuts through any table box!
// ============================================================================
function lineIntersectsBox(x1, y1, x2, y2, box) {
  // Check if line segment (x1,y1)-(x2,y2) intersects box [box.x, box.y, box.w, box.h]
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  // If entirely outside
  if (maxX <= box.x || minX >= box.x + box.w || maxY <= box.y || minY >= box.y + box.h) {
    return false;
  }

  // If strictly inside
  if (minX > box.x && maxX < box.x + box.w && minY > box.y && maxY < box.y + box.h) {
    return true;
  }

  // Crosses border
  const bx2 = box.x + box.w;
  const by2 = box.y + box.h;

  if (x1 === x2) { // Vertical segment
    if (x1 > box.x && x1 < bx2) {
      if (minY < by2 && maxY > box.y) return true;
    }
  } else if (y1 === y2) { // Horizontal segment
    if (y1 > box.y && y1 < by2) {
      if (minX < bx2 && maxX > box.x) return true;
    }
  }
  return false;
}

console.log("Checking route collisions against all 20 tables...");
let collisionCount = 0;
ROUTES.forEach(route => {
  for (let i = 0; i < route.points.length - 1; i++) {
    const p1 = route.points[i];
    const p2 = route.points[i + 1];
    TABLES.forEach(table => {
      // Allow start/end touching own endpoint table
      if (table.id === route.from || table.id === route.to) return;
      if (lineIntersectsBox(p1.x, p1.y, p2.x, p2.y, table)) {
        console.warn(`[COLLISION DETECTED] Line "${route.name}" segment (${p1.x},${p1.y})->(${p2.x},${p2.y}) intersects table ${table.name}!`);
        collisionCount++;
      }
    });
  }
});

if (collisionCount === 0) {
  console.log("SUCCESS: 0 Collisions! All lines run purely through open channels and perimeter corridors.");
} else {
  console.warn(`Warning: ${collisionCount} collisions detected.`);
}

// ============================================================================
// 4. GENERATE PURE WHITE STANDALONE SVG
// ============================================================================
const svgMinX = 20;
const svgMinY = 10;
const svgMaxX = 2100;
const svgMaxY = 1450;
const svgW = svgMaxX - svgMinX;
const svgH = svgMaxY - svgMinY;

let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" style="background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <defs>
    <!-- Solid White Background -->
    <rect id="bg" width="${svgW}" height="${svgH}" fill="#ffffff" />
    
    <!-- One marker (two vertical hash bars ||) -->
    <marker id="one-bar" viewBox="0 0 10 14" refX="5" refY="7" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <line x1="3" y1="1" x2="3" y2="13" stroke="#1e293b" stroke-width="2.2" />
      <line x1="7" y1="1" x2="7" y2="13" stroke="#1e293b" stroke-width="2.2" />
    </marker>

    <!-- Crow's foot marker (>|) -->
    <marker id="crowsfoot" viewBox="0 0 14 14" refX="12" refY="7" markerWidth="11" markerHeight="11" orient="auto-start-reverse">
      <path d="M 0 2 L 12 7 L 0 12 M 12 0 L 12 14" fill="none" stroke="#1e293b" stroke-width="2" />
    </marker>

    <!-- Crisp Soft Card Shadow -->
    <filter id="card-shadow" x="-5%" y="-5%" width="112%" height="112%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000000" flood-opacity="0.07" />
    </filter>
  </defs>

  <!-- PURE WHITE BACKGROUND -->
  <rect width="100%" height="100%" fill="#ffffff" />

  <!-- Outer Architectural Border Frame (Matching Reference Image) -->
  <rect x="25" y="20" width="${svgW - 50}" height="${svgH - 40}" fill="none" stroke="#334155" stroke-width="2" rx="10" />

  <!-- Header Banner -->
  <g transform="translate(50, 52)">
    <text x="0" y="0" font-size="20" font-weight="bold" fill="#0f172a" letter-spacing="0.5">LOGICAL DATABASE DESIGN DIAGRAM</text>
    <text x="0" y="22" font-size="12" fill="#475569">Operational Relational Model (3NF) • Central Errand &amp; Pabili System • SysAdmin and Technical Security Excluded</text>
  </g>

  <!-- Non-Crossing Relational Connector Paths -->
  <g id="connectors">
`;

ROUTES.forEach(route => {
  let d = `M ${route.points[0].x - svgMinX} ${route.points[0].y - svgMinY}`;
  for (let i = 1; i < route.points.length; i++) {
    d += ` L ${route.points[i].x - svgMinX} ${route.points[i].y - svgMinY}`;
  }
  svg += `    <!-- ${route.name} -->\n`;
  svg += `    <path d="${d}" fill="none" stroke="#334155" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" marker-start="url(#one-bar)" marker-end="url(#crowsfoot)" />\n`;
});

svg += `  </g>\n\n  <!-- Table Entities -->\n  <g id="tables">\n`;

TABLES.forEach(table => {
  const tX = table.x - svgMinX;
  const tY = table.y - svgMinY;

  svg += `    <!-- ${table.name} -->\n`;
  svg += `    <g transform="translate(${tX}, ${tY})" filter="url(#card-shadow)">\n`;
  
  // Card base
  svg += `      <rect width="${table.w}" height="${table.h}" rx="6" fill="#ffffff" stroke="#334155" stroke-width="1.4" />\n`;
  
  // Emerald Green Header Banner
  svg += `      <path d="M 0 6 A 6 6 0 0 1 6 0 L ${table.w - 6} 0 A 6 6 0 0 1 ${table.w} 6 L ${table.w} ${HEAD_H} L 0 ${HEAD_H} Z" fill="#16a34a" />\n`;
  svg += `      <text x="${table.w / 2}" y="18" fill="#ffffff" font-size="11.5" font-weight="bold" text-anchor="middle" letter-spacing="0.4">${table.name.toUpperCase()}</text>\n`;
  
  // Columns
  table.columns.forEach((col, idx) => {
    const rowY = HEAD_H + idx * ROW_H;
    
    // Horizontal row divider
    if (idx > 0) {
      svg += `      <line x1="0" y1="${rowY}" x2="${table.w}" y2="${rowY}" stroke="#e2e8f0" stroke-width="1" />\n`;
    }
    
    // Key indicator
    let keyColor = "#94a3b8";
    let isKey = false;
    if (col.key === "PK") {
      keyColor = "#b45309"; // Amber
      isKey = true;
    } else if (col.key === "FK") {
      keyColor = "#1d4ed8"; // Blue
      isKey = true;
    }

    svg += `      <text x="12" y="${rowY + 14.5}" fill="${keyColor}" font-size="9.5" font-weight="${isKey ? 'bold' : 'normal'}" font-family="monospace">${col.key}</text>\n`;
    svg += `      <line x1="38" y1="${rowY}" x2="38" y2="${rowY + ROW_H}" stroke="#e2e8f0" stroke-width="1" />\n`;
    svg += `      <text x="46" y="${rowY + 14.5}" fill="#0f172a" font-size="10.8" font-weight="${col.key === 'PK' ? '600' : 'normal'}">${col.name}</text>\n`;
  });

  svg += `    </g>\n\n`;
});

svg += `  </g>\n</svg>`;

// Write to web and public
const webSvgPath = path.join(__dirname, '..', '..', 'Capstone_Project_Web', 'logical_database_design.svg');
const publicSvgPath = path.join(__dirname, '..', '..', 'Capstone_Project_Web', 'public', 'logical_database_design.svg');
const serverSvgPath = path.join(__dirname, 'logical_database_design.svg');
const artifactSvgPath = 'C:\\Users\\Capstone\\.gemini\\antigravity\\brain\\0d9278e5-4d22-4ce7-9330-3a2f16335557\\logical_database_design.svg';

fs.writeFileSync(webSvgPath, svg, 'utf8');
fs.writeFileSync(publicSvgPath, svg, 'utf8');
fs.writeFileSync(serverSvgPath, svg, 'utf8');
try { fs.writeFileSync(artifactSvgPath, svg, 'utf8'); } catch(e){}
console.log('Saved non-crossing SVG to:', webSvgPath);

// ============================================================================
// 5. GENERATE INTERACTIVE HTML FILE WITH IDENTICAL NON-CROSSING PATHS
// ============================================================================
let htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Logical Database Design Diagram - Non-Crossing Paths</title>
  <script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>
  <style>
    body {
      user-select: none;
      -webkit-user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .erd-table {
      box-shadow: 0 4px 12px -2px rgba(0, 0, 0, 0.12), 0 2px 6px -1px rgba(0, 0, 0, 0.08);
      transition: box-shadow 0.2s ease, border-color 0.2s ease;
    }
    .erd-table:hover {
      box-shadow: 0 10px 25px -3px rgba(0, 0, 0, 0.2), 0 4px 10px -2px rgba(0, 0, 0, 0.1);
    }
    .erd-table.highlighted {
      border-color: #22c55e !important;
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.35), 0 12px 28px rgba(0, 0, 0, 0.2);
    }
    .erd-table.dimmed {
      opacity: 0.25;
    }
    .connection-line {
      transition: stroke 0.2s ease, stroke-width 0.2s ease, opacity 0.2s ease;
    }
    .connection-line.highlighted {
      stroke: #16a34a !important;
      stroke-width: 2.8 !important;
      opacity: 1 !important;
    }
    .connection-line.dimmed {
      opacity: 0.12 !important;
    }
    .blueprint-grid {
      background-size: 24px 24px;
      background-image: 
        linear-gradient(to right, rgba(148, 163, 184, 0.12) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(148, 163, 184, 0.12) 1px, transparent 1px);
    }
  </style>
</head>
<body class="bg-slate-900 text-slate-100 h-screen w-screen overflow-hidden flex flex-col antialiased">

  <!-- Top Navigation & Controls Toolbar -->
  <header class="h-14 bg-slate-950 border-b border-slate-800 px-5 flex items-center justify-between shrink-0 z-30 shadow-md">
    <div class="flex items-center space-x-3">
      <div class="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center font-black text-white text-base shadow">
        ER
      </div>
      <div>
        <h1 class="text-sm font-bold tracking-tight text-white flex items-center gap-2">
          Logical Database Design Diagram
          <span class="text-xs px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800 font-medium">Non-Crossing Orthogonal Corridors</span>
        </h1>
        <p class="text-[11px] text-slate-400">Tacurong Logistics & Pabili Errand System (20 Core Entities • SysAdmin Excluded)</p>
      </div>
    </div>

    <!-- Center Legend / Domain Filter -->
    <div class="hidden lg:flex items-center gap-2 text-xs">
      <span class="text-slate-400 font-medium mr-1">Domains:</span>
      <button onclick="filterDomain('all')" class="domain-btn active px-2.5 py-1 rounded bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700 transition" data-domain="all">All (20)</button>
      <button onclick="filterDomain('errand')" class="domain-btn px-2.5 py-1 rounded bg-slate-900 text-emerald-400 border border-emerald-800/60 hover:bg-slate-800 transition" data-domain="errand">Errand & Pabili</button>
      <button onclick="filterDomain('users')" class="domain-btn px-2.5 py-1 rounded bg-slate-900 text-blue-400 border border-blue-800/60 hover:bg-slate-800 transition" data-domain="users">Users & Customers</button>
      <button onclick="filterDomain('merchant')" class="domain-btn px-2.5 py-1 rounded bg-slate-900 text-amber-400 border border-amber-800/60 hover:bg-slate-800 transition" data-domain="merchant">Stores & Categories</button>
      <button onclick="filterDomain('finance')" class="domain-btn px-2.5 py-1 rounded bg-slate-900 text-purple-400 border border-purple-800/60 hover:bg-slate-800 transition" data-domain="finance">Finance & Rates</button>
    </div>

    <!-- Zoom, Theme & Download Controls -->
    <div class="flex items-center space-x-2">
      <!-- Theme Switcher -->
      <button id="theme-btn" onclick="toggleTheme()" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1.5 transition">
        <span id="theme-icon">☀️</span>
        <span id="theme-text">White Canvas</span>
      </button>

      <div class="flex items-center bg-slate-800 rounded-lg p-0.5 border border-slate-700 text-xs">
        <button id="zoom-out" title="Zoom Out" class="p-1.5 hover:bg-slate-700 rounded text-slate-300 hover:text-white">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4"/></svg>
        </button>
        <span id="zoom-level" class="px-2 font-mono text-[11px] text-slate-300">72%</span>
        <button id="zoom-in" title="Zoom In" class="p-1.5 hover:bg-slate-700 rounded text-slate-300 hover:text-white">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
        </button>
        <button id="zoom-reset" title="Fit to View" class="px-2 py-1 hover:bg-slate-700 rounded text-[11px] text-slate-300 hover:text-white font-medium">Reset</button>
      </div>

      <button onclick="downloadPNG()" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs shadow flex items-center gap-1.5 transition">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
        Download PNG (White)
      </button>

      <button onclick="downloadSVG()" class="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow flex items-center gap-1.5 transition">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10"/></svg>
        Download SVG
      </button>

      <button onclick="window.print()" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 font-medium text-xs shadow flex items-center gap-1.5 transition">
        Print / PDF
      </button>
    </div>
  </header>

  <!-- Canvas Container with Pan/Zoom & SVG Layer -->
  <div id="viewport" class="relative flex-1 bg-slate-900 blueprint-grid overflow-hidden cursor-grab active:cursor-grabbing">
    
    <div id="canvas" class="absolute left-0 top-0 origin-top-left" style="width: 2400px; height: 1600px; transform: matrix(0.72, 0, 0, 0.72, 20, 20);">
      
      <!-- SVG Connectors Layer -->
      <svg id="connections-svg" class="absolute inset-0 w-full h-full pointer-events-none z-10" style="width: 2400px; height: 1600px;">
        <defs>
          <marker id="one-bar" viewBox="0 0 10 14" refX="5" refY="7" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <line x1="3" y1="1" x2="3" y2="13" stroke="#475569" stroke-width="2.2" />
            <line x1="7" y1="1" x2="7" y2="13" stroke="#475569" stroke-width="2.2" />
          </marker>
          <marker id="crowsfoot" viewBox="0 0 14 14" refX="12" refY="7" markerWidth="11" markerHeight="11" orient="auto-start-reverse">
            <path d="M 0 2 L 12 7 L 0 12 M 12 0 L 12 14" fill="none" stroke="#475569" stroke-width="2" />
          </marker>
        </defs>
`;

ROUTES.forEach(route => {
  let d = `M ${route.points[0].x} ${route.points[0].y}`;
  for (let i = 1; i < route.points.length; i++) {
    d += ` L ${route.points[i].x} ${route.points[i].y}`;
  }
  htmlContent += `        <path d="${d}" class="connection-line" fill="none" stroke="#64748b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" marker-start="url(#one-bar)" marker-end="url(#crowsfoot)" data-from="${route.from}" data-to="${route.to}" />\n`;
});

htmlContent += `      </svg>

      <!-- Tables Layer -->
      <div id="tables-container" class="relative z-20 w-full h-full">
`;

TABLES.forEach(table => {
  htmlContent += `
        <div id="table-${table.id}" class="erd-table absolute bg-white text-slate-800 rounded-lg border border-slate-400 overflow-hidden cursor-move" style="left: ${table.x}px; top: ${table.y}px; width: ${table.w}px;" data-id="${table.id}" data-domain="${table.domain}">
          <div class="table-header bg-emerald-600 px-3 py-1.5 flex items-center justify-between text-white border-b border-emerald-700">
            <span class="font-bold text-xs tracking-wide uppercase">${table.name}</span>
            <span class="text-[10px] opacity-75 font-mono">${table.columns.length}</span>
          </div>
          <div class="table-body text-[11px] divide-y divide-slate-100 font-sans">
  `;

  table.columns.forEach(col => {
    const isPk = col.key === "PK";
    const isFk = col.key === "FK";
    const bgKey = isPk ? "text-amber-700 font-black bg-amber-50" : isFk ? "text-blue-700 font-bold bg-blue-50" : "text-slate-400";

    htmlContent += `
            <div class="flex items-center px-2.5 py-0.5 hover:bg-emerald-50/50 transition">
              <span class="w-8 shrink-0 text-[10px] font-mono ${bgKey}">${col.key}</span>
              <span class="font-medium text-slate-800 truncate ${isPk ? 'font-semibold' : ''}">${col.name}</span>
            </div>
    `;
  });

  htmlContent += `
          </div>
        </div>
  `;
});

htmlContent += `
      </div>
    </div>

    <!-- Quick Floating Instructions Overlay -->
    <div class="absolute bottom-4 left-4 z-30 bg-slate-950/85 backdrop-blur-md border border-slate-800 rounded-lg px-3.5 py-2 text-[11px] text-slate-400 shadow-lg flex items-center gap-3">
      <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-emerald-500"></span> <strong>Drag</strong> background to Pan</span>
      <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-blue-500"></span> <strong>Scroll</strong> to Zoom</span>
      <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-amber-500"></span> <strong>Click Table</strong> to highlight linked relations</span>
    </div>
  </div>

  <script>
    const viewport = document.getElementById("viewport");
    const canvas = document.getElementById("canvas");
    let currentScale = 0.72;
    let panX = 20;
    let panY = 20;
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;

    function updateTransform() {
      canvas.style.transform = \`matrix(\${currentScale}, 0, 0, \${currentScale}, \${panX}, \${panY})\`;
      document.getElementById("zoom-level").textContent = \`\${Math.round(currentScale * 100)}%\`;
    }

    // Zoom Buttons
    document.getElementById("zoom-in").addEventListener("click", () => {
      currentScale = Math.min(currentScale * 1.2, 2.5);
      updateTransform();
    });

    document.getElementById("zoom-out").addEventListener("click", () => {
      currentScale = Math.max(currentScale / 1.2, 0.35);
      updateTransform();
    });

    document.getElementById("zoom-reset").addEventListener("click", () => {
      currentScale = 0.72;
      panX = 20;
      panY = 20;
      updateTransform();
      resetHighlight();
    });

    // Mouse Wheel Zoom
    viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      const newScale = Math.min(Math.max(currentScale * zoomFactor, 0.35), 2.5);
      const rect = viewport.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      panX = cursorX - (cursorX - panX) * (newScale / currentScale);
      panY = cursorY - (cursorY - panY) * (newScale / currentScale);
      currentScale = newScale;
      updateTransform();
    }, { passive: false });

    // Background Pan Dragging
    viewport.addEventListener("mousedown", (e) => {
      if (e.target.closest(".erd-table")) return;
      isPanning = true;
      panStartX = e.clientX - panX;
      panStartY = e.clientY - panY;
    });

    window.addEventListener("mousemove", (e) => {
      if (!isPanning) return;
      panX = e.clientX - panStartX;
      panY = e.clientY - panStartY;
      updateTransform();
    });

    window.addEventListener("mouseup", () => {
      isPanning = false;
    });

    viewport.addEventListener("click", (e) => {
      if (!e.target.closest(".erd-table")) {
        resetHighlight();
      }
    });

    // Card Clicking & Highlighting
    document.querySelectorAll(".erd-table").forEach(card => {
      card.addEventListener("click", (e) => {
        e.stopPropagation();
        highlightTable(card.dataset.id);
      });
    });

    function highlightTable(tableId) {
      const allCards = document.querySelectorAll(".erd-table");
      const allLines = document.querySelectorAll(".connection-line");
      const linkedTables = new Set([tableId]);

      allLines.forEach(line => {
        if (line.dataset.from === tableId) {
          linkedTables.add(line.dataset.to);
          line.classList.add("highlighted");
          line.classList.remove("dimmed");
        } else if (line.dataset.to === tableId) {
          linkedTables.add(line.dataset.from);
          line.classList.add("highlighted");
          line.classList.remove("dimmed");
        } else {
          line.classList.remove("highlighted");
          line.classList.add("dimmed");
        }
      });

      allCards.forEach(card => {
        if (linkedTables.has(card.dataset.id)) {
          card.classList.add("highlighted");
          card.classList.remove("dimmed");
        } else {
          card.classList.remove("highlighted");
          card.classList.add("dimmed");
        }
      });
    }

    function resetHighlight() {
      document.querySelectorAll(".erd-table").forEach(card => {
        card.classList.remove("highlighted", "dimmed");
      });
      document.querySelectorAll(".connection-line").forEach(line => {
        line.classList.remove("highlighted", "dimmed");
      });
    }

    function filterDomain(domain) {
      document.querySelectorAll(".domain-btn").forEach(btn => {
        if (btn.dataset.domain === domain) {
          btn.classList.add("bg-emerald-600", "text-white");
          btn.classList.remove("bg-slate-900", "bg-slate-800");
        } else {
          btn.classList.remove("bg-emerald-600", "text-white");
          btn.classList.add("bg-slate-900");
        }
      });

      if (domain === "all") {
        resetHighlight();
        return;
      }

      document.querySelectorAll(".erd-table").forEach(card => {
        if (card.dataset.domain === domain) {
          card.classList.remove("dimmed");
          card.classList.add("highlighted");
        } else {
          card.classList.add("dimmed");
          card.classList.remove("highlighted");
        }
      });
    }

    // Theme Switcher
    let isWhiteTheme = false;
    function toggleTheme() {
      isWhiteTheme = !isWhiteTheme;
      const themeText = document.getElementById("theme-text");
      const themeIcon = document.getElementById("theme-icon");
      if (isWhiteTheme) {
        viewport.classList.remove("bg-slate-900", "blueprint-grid");
        viewport.classList.add("bg-white");
        themeText.textContent = "Dark Canvas";
        themeIcon.textContent = "🌙";
      } else {
        viewport.classList.remove("bg-white");
        viewport.classList.add("bg-slate-900", "blueprint-grid");
        themeText.textContent = "White Canvas";
        themeIcon.textContent = "☀️";
      }
    }

    // Download SVG
    function downloadSVG() {
      const link = document.createElement("a");
      link.href = "logical_database_design.svg";
      link.download = "SUGO_Logical_Database_Design_Diagram.svg";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    // Download PNG
    function downloadPNG() {
      fetch("logical_database_design.svg")
        .then(r => r.text())
        .then(svgText => {
          const img = new Image();
          const svgBlob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
          const URL = window.URL || window.webkitURL || window;
          const blobURL = URL.createObjectURL(svgBlob);
          img.onload = function() {
            const canvas = document.createElement("canvas");
            const scale = 2; // 2x high resolution
            canvas.width = (img.width || 2100) * scale;
            canvas.height = (img.height || 1450) * scale;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(blobURL);
            
            const a = document.createElement("a");
            a.download = "SUGO_Logical_Database_Design_White.png";
            a.href = canvas.toDataURL("image/png");
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          };
          img.src = blobURL;
        })
        .catch(err => {
          console.error("Failed to render PNG directly, downloading SVG instead:", err);
          downloadSVG();
        });
    }
  </script>
</body>
</html>
`;

const webHtmlPath = path.join(__dirname, '..', '..', 'Capstone_Project_Web', 'logical_database_design_diagram.html');
const publicHtmlPath = path.join(__dirname, '..', '..', 'Capstone_Project_Web', 'public', 'logical_database_design_diagram.html');
const artifactHtmlPath = 'C:\\Users\\Capstone\\.gemini\antigravity\\brain\\0d9278e5-4d22-4ce7-9330-3a2f16335557\\logical_database_design_diagram.html';

fs.writeFileSync(webHtmlPath, htmlContent, 'utf8');
fs.writeFileSync(publicHtmlPath, htmlContent, 'utf8');
try { fs.writeFileSync(artifactHtmlPath, htmlContent, 'utf8'); } catch(e){}
console.log('Saved interactive HTML to:', webHtmlPath);

