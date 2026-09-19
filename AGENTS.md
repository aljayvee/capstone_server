# Capstone Express & Prisma Server (Antigravity & Gemini Rules)

This file contains the server-side rules and instructions for Antigravity 2.0 / Gemini models.

---

## 🌐 Dual-Agent Tunnel Invariant (Always Active in All Sessions)
1. **Boot-Time Handshake Check (Step 0)**: In every session, ALWAYS inspect `AGENT_HANDSHAKE.md` before making changes to server code.
2. **Locked Contract Invariant**: Respect all locked Prisma models, API routes, and auth tokens specified by Claude.
3. **Execution & Verification**: After making edits, verify with `npx tsc --noEmit` and update the execution ledger in `AGENT_HANDSHAKE.md`.
4. **Gemini Non-Autonomous Execution & Claude Cognitive Alignment**: Gemini models (Gemini 3.x Pro, Gemini 3.8 Flash High) MUST NOT act autonomously or execute sweeping unilateral changes. Gemini must strictly adopt the 6-stage Claude Cognitive Thinking Process (Context Grounding -> Hypothesis & Trade-offs -> User Consultation Gate -> Surgical Delta -> Defensive Rigor -> Empirical Verification).

---

## Server & Database Invariants

### 1. Database & Schema
- **Database**: MariaDB accessed strictly through Prisma Client singleton (`src/db.ts`).
- **3NF Errand Schema**: `errands` (parent table) + `pabili_details_tbl` (itemized list).
- **Migrations**: All schema changes must be applied via Prisma migrations.

### 2. Route Security & Gatekeeping
- **Rate-Limiting Before Queries**: All mutating routes must pass through `express-rate-limit`.
- **Input Validation**: Server-side validation before database queries.
- **BOLA / IDOR Scoping**: Validate ownership on mutating requests (`verifyDispatcherAccess`).
- **Base URL Prefix**: Routes mounted under `/api/*`.
