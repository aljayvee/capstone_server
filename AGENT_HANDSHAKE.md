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
* **Status**: [Transactional Email & OTP Design Revamped]
* **Files Synchronized**:
  - `C:\Capstone_Server\server\src\lib\emailTemplates.ts` (Revamped email design system: bulletproof MSO table shell, hidden preheaders, clean typography OTP hero, eliminated nested-card abuse and coupon dashed borders, added standardized builders `buildRegistrationOtpEmail`, `buildPasswordResetEmail`, `renderSecurityAdvisory`)
  - `C:\Capstone_Server\server\src\services\emailVerificationService.ts` (Folded `issueCode` and `sendPasswordResetCode` onto centralized builders in `emailTemplates.ts`, eliminating duplicate inline HTML)
  - `C:\Capstone_Server\server\src\services\staffVerificationService.ts` (Integrated categoryBadge and preheader into staff sign-in OTP email)
  - `C:\Capstone_Server\server\src\services\loginNotificationService.ts` (Integrated `renderSecurityAdvisory` and preheader into staff login alert email)
  - `C:\Capstone_Server\server\tests\emailTemplates.test.ts` (Created comprehensive unit tests for XSS escaping, template structure, and zero-card assertions)
  - `C:\Capstone_Server\server\scripts\generateEmailPreviews.ts` (Browser preview generator for local visual inspection)
  - `C:\Capstone_Project_Web\public\preview-emails.html` (Accessible browser preview for all 4 transactional emails)
* **Verification Ledger**:
  - `npx tsc --noEmit` verified with 0 errors on Capstone_Server/server.
  - `npm test -- tests/emailTemplates.test.ts tests/registrationOtp.test.ts tests/otpCooldownPolicy.test.ts` verified with 26/26 tests passing.
* **Directives for Claude / Future Sessions**:
  - All transactional emails must be created through `src/lib/emailTemplates.ts` builders rather than inline HTML strings.
  - Maintain the zero-nested-card policy and bulletproof table markup across any future email templates.

