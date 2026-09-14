# 🌐 DUAL-MODEL COLLABORATION TUNNEL (CLAUDE ◄► GEMINI) - SERVER BACKEND

> **ALWAYS ACTIVE IN ALL SESSIONS**: This file is the shared living memory between Claude App (Anthropic) and Antigravity 2.0 (Google AI / Gemini) for the Express / MariaDB / Prisma backend.

---

## 📡 Tunnel State
* **Active Mission**: Server API Architecture & Database Invariants
* **Current Driver**: Antigravity 2.0 (Gemini 3.7 Flash High)
* **Target Workspace**: `Capstone_Server/server` (Port 5000 API Backend)
* **Last Updated**: 2026-09-11

---

## 🔒 LOCKED CONTRACT REGISTRY (ZERO-REGRESSION POLICY)
* `[LOCKED]` `Prisma Schema 3NF Model` (`prisma/schema.prisma` -> `errands`, `pabili_details_tbl`, `users`, `dispatch_logs`)
* `[LOCKED]` `API Base URL Route Prefix Invariant` (All endpoints strictly mounted under `/api/*`)
* `[LOCKED]` `Rate Limiting & Server Validation Invariant` (Rate limiter -> Zod/Express validator -> Database execution)
* `[LOCKED]` `BOLA/IDOR Dispatcher Authorization` (`verifyDispatcherAccess` on all mutating routes)
* `[LOCKED]` `Rotating Refresh Token Architecture` (SHA-256 session hash in `user_sessions`, 10s grace window)

---

## 🧠 Model A (Claude) Blueprint & Directives
* **Status**: [Ready for Claude Ingestion]
* **Directives for Gemini**:
  - Never bypass Express middleware or write raw un-parameterized SQL queries.
  - Strictly use Prisma Client singleton (`src/db.ts`).

---

## 🛠️ Model B (Gemini / Antigravity) Execution & Verification
* **Status**: [Initialized & Ready]
* **Files Synchronized**:
  - `C:\Capstone_Server\server\AGENT_HANDSHAKE.md`
  - `C:\Capstone_Server\server\CLAUDE.md`
  - `C:\Capstone_Server\server\AGENTS.md`
* **Verification Ledger**:
  - Server endpoints follow RESTful conventions.
