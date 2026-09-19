import fs from "node:fs";
import path from "node:path";
import {
  buildRegistrationOtpEmail,
  buildPasswordResetEmail,
  renderEmailShell,
  renderCodeBlock,
  renderDetailRows,
  renderSecurityAdvisory,
} from "../src/lib/emailTemplates.js";

// Generate all 4 emails
const registrationEmail = buildRegistrationOtpEmail("849216", 15);
const passwordResetEmail = buildPasswordResetEmail("502841", 15);

const staffOtpEmail = {
  subject: "Your Sugo Express Sign-In Verification Code",
  html: renderEmailShell({
    title: "Verify Your Sign-In",
    subtitle: "Hi Juan, confirm this email address to finish setting up your staff account.",
    bodyHtml: renderCodeBlock("391054", 15),
    footerNote:
      "If you did not try to sign in to Sugo Express, contact your system administrator immediately.",
    categoryBadge: "STAFF VERIFICATION",
    preheader: "Your Sugo Express verification code is 391054. Valid for 15 minutes.",
  }),
};

const staffAlertEmail = {
  subject: "New sign-in to your Sugo Express account",
  html: renderEmailShell({
    title: "New Sign-In Detected",
    subtitle: "Your Sugo Express account was just used to sign in.",
    bodyHtml: `
      ${renderDetailRows([
        { label: "Name", value: "Juan Dela Cruz" },
        { label: "Account", value: "juan_dispatcher (Dispatcher)" },
        { label: "Signed in to", value: "Sugo Express Web Portal" },
        { label: "Device", value: "Chrome on Windows 11" },
        { label: "Time", value: "Saturday, September 19, 2026 at 4:15 PM (PHT)" },
        { label: "IP address", value: "112.201.164.82" },
      ])}
      ${renderSecurityAdvisory(
        "Security Alert",
        "If you do not recognize this activity, your credentials may be compromised. Please notify your system administrator immediately to lock and secure your account."
      )}
    `,
    footerNote:
      "If this was you, no action is needed. If you do not recognise this sign-in, contact your system administrator immediately.",
    categoryBadge: "SECURITY AUDIT",
    preheader: "New sign-in to your Sugo Express account from Chrome on Windows 11.",
  }),
};

const previewContainerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sugo Express — Professional Email Design Previews</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: #0F172A;
      color: #F8FAFC;
      padding: 24px;
    }
    .header {
      max-width: 1200px;
      margin: 0 auto 24px auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #334155;
      padding-bottom: 16px;
    }
    .header h1 {
      font-size: 20px;
      font-weight: 700;
      color: #FFFFFF;
      letter-spacing: -0.5px;
    }
    .header p {
      font-size: 13px;
      color: #94A3B8;
      margin-top: 4px;
    }
    .tabs {
      display: flex;
      gap: 8px;
    }
    .tab-btn {
      background: #1E293B;
      color: #94A3B8;
      border: 1px solid #334155;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .tab-btn.active, .tab-btn:hover {
      background: #E53935;
      color: #FFFFFF;
      border-color: #E53935;
    }
    .preview-container {
      max-width: 1200px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(560px, 1fr));
      gap: 28px;
    }
    .card {
      background: #1E293B;
      border: 1px solid #334155;
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .card-header {
      padding: 14px 18px;
      background: #182234;
      border-bottom: 1px solid #334155;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: #F1F5F9;
    }
    .card-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 4px;
      background: #334155;
      color: #CBD5E1;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .subject-line {
      font-size: 12px;
      color: #94A3B8;
      padding: 8px 18px;
      background: #0F172A;
      border-bottom: 1px solid #334155;
      font-family: monospace;
    }
    .frame-wrapper {
      flex: 1;
      min-height: 640px;
      background: #F8FAFC;
    }
    iframe {
      width: 100%;
      height: 100%;
      min-height: 640px;
      border: none;
      background: #F8FAFC;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Sugo Express — Transactional Email Redesign Previews</h1>
      <p>Executive, professional email design system &bull; Zero nested-card abuse &bull; Bulletproof cross-client HTML</p>
    </div>
  </div>

  <div class="preview-container">
    <!-- 1. Customer Registration OTP -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">1. Customer Registration OTP</span>
        <span class="card-badge">Customer Flow</span>
      </div>
      <div class="subject-line">Subject: ${registrationEmail.subject}</div>
      <div class="frame-wrapper">
        <iframe srcdoc="${registrationEmail.html.replace(/"/g, "&quot;")}"></iframe>
      </div>
    </div>

    <!-- 2. Customer Password Reset OTP -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">2. Customer Password Reset OTP</span>
        <span class="card-badge">Security Flow</span>
      </div>
      <div class="subject-line">Subject: ${passwordResetEmail.subject}</div>
      <div class="frame-wrapper">
        <iframe srcdoc="${passwordResetEmail.html.replace(/"/g, "&quot;")}"></iframe>
      </div>
    </div>

    <!-- 3. Staff Sign-In OTP -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">3. Staff First Sign-In OTP</span>
        <span class="card-badge">Staff Operations</span>
      </div>
      <div class="subject-line">Subject: ${staffOtpEmail.subject}</div>
      <div class="frame-wrapper">
        <iframe srcdoc="${staffOtpEmail.html.replace(/"/g, "&quot;")}"></iframe>
      </div>
    </div>

    <!-- 4. Staff Sign-In Security Alert -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">4. Staff Sign-In Security Alert</span>
        <span class="card-badge">Security Audit</span>
      </div>
      <div class="subject-line">Subject: ${staffAlertEmail.subject}</div>
      <div class="frame-wrapper">
        <iframe srcdoc="${staffAlertEmail.html.replace(/"/g, "&quot;")}"></iframe>
      </div>
    </div>
  </div>
</body>
</html>`;

const scratchPath = "C:/Users/Capstone/.gemini/antigravity/brain/5af67af8-ab95-4d1a-a1b5-48f8c41dc135/scratch/preview-emails.html";
const publicWebPath = "C:/Capstone_Project_Web/public/preview-emails.html";

fs.mkdirSync(path.dirname(scratchPath), { recursive: true });
fs.writeFileSync(scratchPath, previewContainerHtml, "utf-8");
fs.writeFileSync(publicWebPath, previewContainerHtml, "utf-8");

console.log("Successfully generated email previews at:");
console.log(" - Scratch:", scratchPath);
console.log(" - Public Web:", publicWebPath);
