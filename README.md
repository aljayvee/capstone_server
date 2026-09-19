# SUGO On-The-Go Backend Server

Backend API server for the SUGO On-The-Go logistics and on-demand errand fulfillment platform in Tacurong City, Philippines.

The server coordinates real-time errand lifecycles, GIS road-network routing, rider fleet telemetry, multi-tier pricing, receipt OCR verification, and financial settlement across three client applications:
1. Web Operations Portal (Owner and Dispatcher consoles)
2. Customer Mobile Application (React Native / Expo)
3. Rider Mobile Application (React Native / Expo)

---

## Technical Stack

- Runtime: Node.js (ES Modules)
- Language: TypeScript (Strict mode enabled)
- HTTP Framework: Express 4
- Relational Database: MariaDB (accessed via Prisma ORM)
- Real-Time Services: Firebase Admin SDK, Socket.IO
- GIS and Routing: OSRM (Open Source Routing Machine), Google Directions API
- Computer Vision: Google Cloud Vision API (server-side receipt verification)
- Testing Framework: Vitest
- Document Generation: PDFKit (accounting reports and settlement exports)

---

## System Architecture

### 1. Hybrid Data Architecture
The platform divides responsibilities between relational integrity and real-time event streaming:
- MariaDB (Primary Authority): Stores all persistent, transactional, and audit records in 3NF schema, including user accounts, errand states, merchant pinpoints, fee breakdowns, payment ledgers, and settlement variance logs.
- Firebase: Manages user authentication tokens, live rider GPS coordinate streaming, low-latency chat signaling, and Cloud Messaging (FCM) notifications.

### 2. GIS Road-Network Routing
Fares and ETAs rely on road-network geometry rather than straight-line distance. The routing service uses a resilient provider chain:
1. Local OSRM instance with Tacurong City road graph
2. Google Directions API fallback
3. Detour-scaled Haversine calculation (terminal fallback)

Errand arrival estimates account for both travel time and category-specific store wait times (P50/P80 dwell percentiles learned nightly from past deliveries).

### 3. Authentication and Security
- Access Tokens: Short-lived (15 minutes), decoded and verified statelessly.
- Refresh Tokens: Rotating 30-day tokens stored in HttpOnly cookies or secure mobile storage. Replay detection revokes compromised sessions immediately.
- Rate Limiting: Tiered express-rate-limit middleware applied across auth endpoints, mutation routes, and public read endpoints.
- Object Authorization (BOLA/IDOR Defense): Dispatcher operations are verified against active assignment ownership before permitting status transitions or item modifications.

---

## Directory Structure

```text
server/
├── prisma/
│   ├── schema.prisma            # Prisma schema and relational models
│   ├── migrations/              # Migration history
│   └── seedPlaces.ts            # Seed script for verified POIs
├── src/
│   ├── config/                  # Environment variable validation
│   ├── controllers/             # Express request/response handlers
│   ├── jobs/                    # Scheduled cron tasks (dwell learning, snapshots)
│   ├── lib/                     # Singletons (Prisma, Socket.IO, logger, OCR)
│   ├── middleware/              # Auth, RBAC, rate-limiting, error handling
│   ├── repositories/            # Direct Prisma data access layer
│   ├── routes/                  # Express route definitions mounted under /api
│   ├── services/                # Business logic, fee formulas, validations
│   ├── validators/              # Zod request validation schemas
│   └── index.ts                 # Server entry point and HTTP listener
├── tests/                       # Unit and integration test suites
├── package.json
└── tsconfig.json
```

---

## Getting Started

### Prerequisites

- Node.js 20.x or higher
- MariaDB 10.5+ or MySQL 8.0+
- npm 10.x or higher

### 1. Installation

Clone the repository and install dependencies:

```bash
cd server
npm install
```

### 2. Environment Configuration

Create a `.env` file in the `server` root directory:

```env
# Server
PORT=5000
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:8081

# Database (MariaDB / MySQL)
DATABASE_URL="mysql://capstone_user:YourSecurePassword@localhost:3306/errand_system_db?connection_limit=10&pool_timeout=20"

# JWT Authentication
JWT_SECRET=your_jwt_access_secret_key_here
JWT_REFRESH_SECRET=your_jwt_refresh_secret_key_here
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d

# Firebase Admin SDK
FIREBASE_PROJECT_ID=capstonedata-3589c
FIREBASE_CLIENT_EMAIL=your-service-account@capstonedata-3589c.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://capstonedata-3589c-default-rtdb.asia-southeast1.firebasedatabase.app/

# Third-Party APIs
GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
```

### 3. Database Initialization

Generate the Prisma client and apply database migrations:

```bash
# Generate Prisma client
npm run prisma:generate

# Apply migrations
npm run prisma:migrate

# Seed initial verified merchants and default operational accounts
npm run seed
```

### 4. Running the Server

Start in development mode with live reload:

```bash
npm run dev
```

Build and run in production mode:

```bash
npm run build
npm start
```

---

## Available Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Starts the server in development mode using `tsx watch` |
| `npm run build` | Compiles TypeScript source files into `dist/` |
| `npm start` | Executes compiled production server from `dist/index.js` |
| `npm test` | Runs the test suite via Vitest |
| `npm run test:watch` | Runs Vitest in interactive watch mode |
| `npm run prisma:migrate` | Deploys pending Prisma database migrations |
| `npm run prisma:push` | Pushes schema state directly to database (prototyping only) |
| `npm run seed` | Seeds verified merchant establishments and test users |

---

## API Routes Overview

All endpoints are mounted under the `/api` prefix:

| Route Path | Description | Access |
| :--- | :--- | :--- |
| `/api/health` | Service uptime and connectivity health check | Public |
| `/api/auth/*` | Staff login, token refresh, and logout | Public / Authenticated |
| `/api/customers/*` | Customer profile management and registration | Customer |
| `/api/errands/*` | Errand creation, dispatching, and lifecycle updates | Authenticated |
| `/api/riders/*` | Rider fleet roster, duty status, and GPS ingestion | Dispatcher / Owner |
| `/api/reports/*` | Sales, settlements, exception audits, and PDF exports | Owner only |
| `/api/merchant-categories/*`| Active category listing and fee configurations | Public / Owner |
| `/api/places/*` | Verified store catalog and branch coordinates | Authenticated |
| `/api/routing/*` | Road distance matrix and polyline route calculations | Authenticated |

---

## Production Deployment

Production instances run on Linux (Ubuntu 22.04 LTS / Debian 12) under a process supervisor (PM2) behind an Nginx reverse proxy with SSL termination:

```bash
# Compile latest changes
npm run build

# Start or restart process via PM2
pm2 start dist/index.js --name "capstone-backend"
# or
pm2 restart capstone-backend
```

Nginx forwards external requests to port 5000 and supplies client IPs via the `X-Forwarded-For` header.

---

## Author and Project Ownership

- Project Owner and Lead Developer: Aljayvee P. Versola
- GitHub: [@aljayvee](https://github.com/aljayvee)
- Repository: [capstone_server](https://github.com/aljayvee/capstone_server)

---

## License

This project is licensed under the Apache-2.0 License.
