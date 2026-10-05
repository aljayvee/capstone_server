const fs = require('fs');
const path = require('path');

const TABLES = [
  {
    id: "errands",
    name: "errands_tbl",
    x: 1220,
    y: 650,
    width: 250,
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
    id: "pabili_details",
    name: "pabili_details_tbl",
    x: 1220,
    y: 280,
    width: 240,
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
    id: "pabili_item_requests",
    name: "pabili_item_requests_tbl",
    x: 880,
    y: 280,
    width: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "errandId" },
      { key: "FK", name: "pinpointId" },
      { key: "",   name: "itemName" },
      { key: "",   name: "storeCategory" },
      { key: "",   name: "quantity" },
      { key: "",   name: "createdAt" }
    ]
  },
  {
    id: "errand_pinpoints",
    name: "errand_pinpoints_tbl",
    x: 1600,
    y: 280,
    width: 230,
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
    id: "merchant_categories",
    name: "merchant_categories_tbl",
    x: 1980,
    y: 280,
    width: 230,
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
    x: 1980,
    y: 560,
    width: 230,
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
    id: "payment_modes",
    name: "payment_modes_tbl",
    x: 1650,
    y: 650,
    width: 210,
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
    x: 1650,
    y: 840,
    width: 230,
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
    id: "dispatch_logs",
    name: "dispatch_logs_tbl",
    x: 1220,
    y: 1220,
    width: 220,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "errandId" },
      { key: "FK", name: "dispatcherId" },
      { key: "",   name: "notes" },
      { key: "",   name: "dispatchedAt" },
      { key: "",   name: "verifiedAt" }
    ]
  },
  {
    id: "errand_decline_reasons",
    name: "errand_decline_reasons_tbl",
    x: 880,
    y: 1220,
    width: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "errandId" },
      { key: "FK", name: "dispatcherId" },
      { key: "",   name: "reason" },
      { key: "",   name: "isCustom" },
      { key: "",   name: "createdAt" }
    ]
  },
  {
    id: "users",
    name: "users_tbl",
    x: 1600,
    y: 1220,
    width: 240,
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
  {
    id: "rider_presence",
    name: "rider_presence_tracking_tbl",
    x: 1980,
    y: 1220,
    width: 240,
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
    id: "customer_accounts",
    name: "customer_accounts_tbl",
    x: 750,
    y: 650,
    width: 230,
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
    id: "customer_information",
    name: "customer_information_tbl",
    x: 420,
    y: 650,
    width: 230,
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
    id: "saved_delivery_locations",
    name: "saved_delivery_locations_tbl",
    x: 420,
    y: 910,
    width: 240,
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
    id: "errand_payments",
    name: "errand_payments_tbl",
    x: 880,
    y: 1540,
    width: 230,
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
    x: 1220,
    y: 1540,
    width: 230,
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
    x: 1600,
    y: 1540,
    width: 230,
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
  },
  {
    id: "ratings",
    name: "ratings_tbl",
    x: 1980,
    y: 950,
    width: 220,
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
    id: "notifications",
    name: "notifications_tbl",
    x: 1980,
    y: 1540,
    width: 230,
    columns: [
      { key: "PK", name: "id" },
      { key: "FK", name: "userId" },
      { key: "FK", name: "customerId" },
      { key: "",   name: "type" },
      { key: "",   name: "title" },
      { key: "",   name: "body" },
      { key: "",   name: "isRead" }
    ]
  }
];

const RELATIONS = [
  { from: "customer_accounts", to: "customer_information" },
  { from: "customer_accounts", to: "saved_delivery_locations" },
  { from: "customer_accounts", to: "errands" },
  { from: "users", to: "errands" },
  { from: "payment_modes", to: "errands" },
  { from: "errands", to: "pabili_details" },
  { from: "errands", to: "pabili_item_requests" },
  { from: "errands", to: "errand_pinpoints" },
  { from: "merchant_categories", to: "errand_pinpoints" },
  { from: "merchant_categories", to: "verified_places" },
  { from: "verified_places", to: "errand_pinpoints" },
  { from: "errand_pinpoints", to: "pabili_details" },
  { from: "errands", to: "dispatch_logs" },
  { from: "users", to: "dispatch_logs" },
  { from: "errands", to: "errand_decline_reasons" },
  { from: "users", to: "errand_decline_reasons" },
  { from: "errands", to: "errand_payments" },
  { from: "errands", to: "settlement_records" },
  { from: "users", to: "settlement_records" },
  { from: "errands", to: "rider_commissions" },
  { from: "users", to: "rider_commissions" },
  { from: "users", to: "rider_presence" },
  { from: "errands", to: "ratings" },
  { from: "users", to: "ratings" },
  { from: "users", to: "notifications" }
];

// Calculate heights
const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 30;
TABLES.forEach(t => {
  t.height = HEADER_HEIGHT + t.columns.length * ROW_HEIGHT;
});

// Canvas bounds
const minX = 350;
const minY = 200;
const maxX = 2300;
const maxY = 1950;
const width = maxX - minX;
const height = maxY - minY;

let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <defs>
    <!-- Solid White Background -->
    <rect id="bg" width="${width}" height="${height}" fill="#ffffff" />
    
    <!-- One marker (two vertical hash bars ||) -->
    <marker id="one-bar" viewBox="0 0 10 14" refX="5" refY="7" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <line x1="3" y1="1" x2="3" y2="13" stroke="#334155" stroke-width="2" />
      <line x1="7" y1="1" x2="7" y2="13" stroke="#334155" stroke-width="2" />
    </marker>

    <!-- Crow's foot marker (>|) -->
    <marker id="crowsfoot" viewBox="0 0 14 14" refX="12" refY="7" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
      <path d="M 0 2 L 12 7 L 0 12 M 12 0 L 12 14" fill="none" stroke="#334155" stroke-width="1.8" />
    </marker>

    <!-- Drop Shadow for Tables -->
    <filter id="shadow" x="-5%" y="-5%" width="115%" height="115%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000000" flood-opacity="0.08" />
    </filter>
  </defs>

  <!-- PURE WHITE BACKGROUND -->
  <rect width="100%" height="100%" fill="#ffffff" />
  
  <!-- Subtle border frame -->
  <rect x="15" y="15" width="${width - 30}" height="${height - 30}" fill="none" stroke="#e2e8f0" stroke-width="2" rx="12" />

  <!-- Diagram Header Title Block -->
  <g transform="translate(40, 50)">
    <text x="0" y="0" font-size="22" font-weight="bold" fill="#0f172a">SUGO LOGISTICS - LOGICAL DATABASE DESIGN DIAGRAM</text>
    <text x="0" y="24" font-size="13" fill="#64748b">3NF Relational Model (Operational Core: 20 Entities • SysAdmin Tables Excluded)</text>
  </g>

  <!-- Connector Lines -->
  <g id="connectors">
`;

// Helper map
const tableMap = {};
TABLES.forEach(t => { tableMap[t.id] = t; });

RELATIONS.forEach(rel => {
  const from = tableMap[rel.from];
  const to = tableMap[rel.to];
  if (!from || !to) return;

  const fX = from.x - minX;
  const fY = from.y - minY;
  const tX = to.x - minX;
  const tY = to.y - minY;

  const p1 = { x: fX + from.width / 2, y: fY + from.height / 2 };
  const p2 = { x: tX + to.width / 2, y: tY + to.height / 2 };

  let startX, startY, endX, endY;

  if (Math.abs(p1.x - p2.x) > Math.abs(p1.y - p2.y)) {
    if (p1.x < p2.x) {
      startX = fX + from.width;
      startY = fY + 40;
      endX = tX;
      endY = tY + 40;
    } else {
      startX = fX;
      startY = fY + 40;
      endX = tX + to.width;
      endY = tY + 40;
    }
  } else {
    if (p1.y < p2.y) {
      startX = fX + from.width / 2;
      startY = fY + from.height;
      endX = tX + to.width / 2;
      endY = tY;
    } else {
      startX = fX + from.width / 2;
      startY = fY;
      endX = tX + to.width / 2;
      endY = tY + to.height;
    }
  }

  const midX = startX + (endX - startX) / 2;
  const d = `M ${startX} ${startY} L ${midX} ${startY} L ${midX} ${endY} L ${endX} ${endY}`;

  svg += `    <path d="${d}" fill="none" stroke="#475569" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" marker-start="url(#one-bar)" marker-end="url(#crowsfoot)" />\n`;
});

svg += `  </g>\n\n  <!-- Table Entities -->\n  <g id="tables">\n`;

TABLES.forEach(table => {
  const tX = table.x - minX;
  const tY = table.y - minY;

  svg += `    <!-- ${table.name} -->\n`;
  svg += `    <g transform="translate(${tX}, ${tY})" filter="url(#shadow)">\n`;
  
  // Card background & border
  svg += `      <rect width="${table.width}" height="${table.height}" rx="6" fill="#ffffff" stroke="#94a3b8" stroke-width="1.2" />\n`;
  
  // Green Header Bar (matching reference image)
  svg += `      <path d="M 0 6 A 6 6 0 0 1 6 0 L ${table.width - 6} 0 A 6 6 0 0 1 ${table.width} 6 L ${table.width} ${HEADER_HEIGHT} L 0 ${HEADER_HEIGHT} Z" fill="#16a34a" />\n`;
  svg += `      <text x="${table.width / 2}" y="19" fill="#ffffff" font-size="11.5" font-weight="bold" text-anchor="middle" letter-spacing="0.5">${table.name.toUpperCase()}</text>\n`;
  
  // Columns
  table.columns.forEach((col, idx) => {
    const rowY = HEADER_HEIGHT + idx * ROW_HEIGHT;
    
    // Dividing line
    if (idx > 0) {
      svg += `      <line x1="0" y1="${rowY}" x2="${table.width}" y2="${rowY}" stroke="#f1f5f9" stroke-width="1" />\n`;
    }
    
    // Key indicator (PK / FK)
    let keyFill = "#94a3b8";
    let isKey = false;
    if (col.key === "PK") {
      keyFill = "#b45309"; // Amber
      isKey = true;
    } else if (col.key === "FK") {
      keyFill = "#1d4ed8"; // Blue
      isKey = true;
    }

    svg += `      <text x="12" y="${rowY + 15}" fill="${keyFill}" font-size="9.5" font-weight="${isKey ? 'bold' : 'normal'}" font-family="monospace">${col.key}</text>\n`;
    svg += `      <line x1="38" y1="${rowY}" x2="38" y2="${rowY + ROW_HEIGHT}" stroke="#f1f5f9" stroke-width="1" />\n`;
    svg += `      <text x="46" y="${rowY + 15}" fill="#1e293b" font-size="11" font-weight="${col.key === 'PK' ? '600' : 'normal'}">${col.name}</text>\n`;
  });

  svg += `    </g>\n\n`;
});

svg += `  </g>\n</svg>`;

const outputPath = path.join(__dirname, 'logical_database_design.svg');
fs.writeFileSync(outputPath, svg, 'utf8');
console.log('Saved SVG to:', outputPath);
