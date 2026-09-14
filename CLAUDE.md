# Capstone Express & Prisma Server (Claude Protocol)

This file contains the server-side rules and instructions for Claude App / Claude Desktop.

---

## 🌐 Dual-Agent Tunnel Invariant (Always Active in All Sessions)
1. **Boot-Time Handshake Check (Step 0)**: In every session, ALWAYS inspect `AGENT_HANDSHAKE.md` in this directory before designing or modifying backend code.
2. **Locked Contract Invariant**: NEVER modify any Prisma schema model or API signature marked `[LOCKED]` in `AGENT_HANDSHAKE.md`.
3. **Surgical Diffs**: Always generate precise, minimal edits.

---

## Server & Database Invariants

### 1. Database & Schema
- **Database**: MariaDB accessed strictly through Prisma Client singleton (`src/db.ts`).
- **3NF Errand Schema**: `errands` (parent table) + `pabili_details_tbl` (itemized list). The legacy `pabili_orders` table is strictly forbidden.
- **Migrations**: All schema changes must be applied via Prisma migrations.

### 2. Route Security & Gatekeeping
- **Rate-Limiting Before Queries**: All mutating routes (`POST`, `PUT`, `PATCH`, `DELETE`) must pass through `express-rate-limit`.
- **Input Validation**: Strictly validate inputs on the server using Zod or Express-validator before touching the database.
- **BOLA / IDOR Scoping**: Validate dispatcher and user ownership on every mutating request (`verifyDispatcherAccess`).
- **Base URL Prefix**: Every route MUST mount under `/api/*`.

### 3. Authentication & Sessions
- **Access Token**: Short-lived (15m).
- **Refresh Token**: 30-day rotating token with SHA-256 session hash stored in `user_sessions`, 10s grace window for concurrent requests.
