// Shared professional design system for transactional emails across Sugo Express.
// Engineered with bulletproof cross-client HTML (Outlook, Gmail, Apple Mail, mobile).
// Designed with clean typographic hierarchy, generous whitespace, and zero nested-card abuse.

// Any value interpolated into an email body that did not originate in this
// codebase must go through this first. The user-agent on a login alert is
// entirely attacker-controlled text landing in an HTML document.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmailShellOptions {
  title: string;
  subtitle: string;
  bodyHtml: string;
  footerNote: string;
  preheader?: string;
  categoryBadge?: string;
}

/**
 * Bulletproof email shell conforming to modern transactional design standards.
 * Eliminates nested card boxes in favor of clean margins, subtle hairlines, and typography.
 */
export function renderEmailShell({
  title,
  subtitle,
  bodyHtml,
  footerNote,
  preheader,
  categoryBadge = "SECURITY VERIFICATION",
}: EmailShellOptions): string {
  const previewText = preheader || `${title} - ${subtitle}`;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${escapeHtml(title)}</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td { font-family: Arial, Helvetica, sans-serif !important; }
  </style>
  <![endif]-->
</head>
<body style="margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #F8FAFC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <!-- Hidden inbox preview snippet -->
  <div style="display: none; font-size: 1px; line-height: 1px; max-height: 0px; max-width: 0px; opacity: 0; overflow: hidden; mso-hide: all;">
    ${escapeHtml(previewText)}
    &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>

  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F8FAFC; table-layout: fixed;">
    <tr>
      <td align="center" style="padding: 36px 16px 48px 16px;">
        <!--[if (gte mso 9)|(IE)]>
        <table role="presentation" align="center" border="0" cellpadding="0" cellspacing="0" width="560">
        <tr>
        <td>
        <![endif]-->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 560px; background-color: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 8px;">
          <!-- Brand Header Row -->
          <tr>
            <td style="padding: 32px 36px 24px 36px; border-bottom: 1px solid #F1F5F9;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="left" style="vertical-align: middle;">
                    <span style="font-size: 18px; font-weight: 800; letter-spacing: 0.5px; color: #0F172A; text-transform: uppercase;">
                      SUGO<span style="color: #E53935; font-size: 22px; line-height: 0;">.</span>
                    </span>
                    <span style="font-size: 11px; font-weight: 700; letter-spacing: 1.5px; color: #64748B; margin-left: 6px; text-transform: uppercase;">
                      EXPRESS
                    </span>
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <span style="font-size: 10px; font-weight: 700; color: #64748B; background-color: #F1F5F9; border: 1px solid #E2E8F0; padding: 4px 8px; border-radius: 4px; letter-spacing: 0.75px; text-transform: uppercase; white-space: nowrap;">
                      ${escapeHtml(categoryBadge)}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content Body -->
          <tr>
            <td style="padding: 32px 36px 28px 36px;">
              <h1 style="margin: 0 0 10px 0; font-size: 22px; font-weight: 700; line-height: 28px; color: #0F172A; letter-spacing: -0.25px;">
                ${escapeHtml(title)}
              </h1>
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 22px; color: #475569;">
                ${escapeHtml(subtitle)}
              </p>

              ${bodyHtml}
            </td>
          </tr>

          <!-- Corporate Footer -->
          <tr>
            <td style="padding: 24px 36px 32px 36px; border-top: 1px solid #E2E8F0; background-color: #FAFAFA; border-bottom-left-radius: 8px; border-bottom-right-radius: 8px;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center" style="font-size: 12px; line-height: 18px; color: #94A3B8;">
                    <p style="margin: 0 0 6px 0;">${escapeHtml(footerNote)}</p>
                    <p style="margin: 0 0 6px 0; color: #64748B;">Sugo Express &bull; Tacurong City, Sultan Kudarat, Philippines</p>
                    <p style="margin: 0; font-size: 11px; color: #94A3B8;">&copy; 2026 Sugo Express. All rights reserved.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <!--[if (gte mso 9)|(IE)]>
        </td>
        </tr>
        </table>
        <![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Professional typographic OTP code section.
 * Avoids nested card boxes. Uses clean top/bottom anchor rules, spacious monospace glyphs,
 * and clear single-use expiry metadata.
 */
export function renderCodeBlock(code: string, expiryMinutes: number): string {
  return `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 8px 0 24px 0;">
      <tr>
        <td align="center" style="padding: 24px 16px; background-color: #F8FAFC; border-top: 2px solid #0F172A; border-bottom: 1px solid #E2E8F0;">
          <div style="font-size: 11px; font-weight: 700; letter-spacing: 2px; color: #64748B; text-transform: uppercase; margin-bottom: 12px;">
            Verification Code
          </div>
          <div style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size: 38px; font-weight: 800; letter-spacing: 12px; color: #0F172A; line-height: 1; padding-left: 12px;">
            ${escapeHtml(code)}
          </div>
          <div style="font-size: 12px; color: #64748B; font-weight: 500; margin-top: 14px;">
            Expires in <strong style="color: #0F172A;">${expiryMinutes} minutes</strong> &bull; Single-use only
          </div>
        </td>
      </tr>
    </table>
  `;
}

/**
 * Clean security advisory callout without nested card clutter.
 */
export function renderSecurityAdvisory(title: string, message: string): string {
  return `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 20px 0 4px 0; border-left: 3px solid #CBD5E1; padding-left: 14px;">
      <tr>
        <td>
          <p style="margin: 0; font-size: 12px; line-height: 19px; color: #64748B;">
            <strong style="color: #334155;">${escapeHtml(title)}:</strong> ${escapeHtml(message)}
          </p>
        </td>
      </tr>
    </table>
  `;
}

/**
 * Clean tabular key-value layout for security and login alerts.
 * Uses clean horizontal hairlines rather than nested card containers.
 */
export function renderDetailRows(rows: Array<{ label: string; value: string }>): string {
  const cells = rows
    .map(
      ({ label, value }) => `
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #F1F5F9; font-size: 13px; color: #64748B; vertical-align: top; width: 34%; white-space: nowrap;">
              ${escapeHtml(label)}
            </td>
            <td style="padding: 10px 0 10px 16px; border-bottom: 1px solid #F1F5F9; font-size: 13px; font-weight: 600; color: #0F172A; vertical-align: top; word-break: break-word;">
              ${escapeHtml(value)}
            </td>
          </tr>`
    )
    .join("");

  return `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 16px 0 24px 0; border-top: 1px solid #E2E8F0;">
      <tbody>${cells}</tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// Standardized Transactional Email Builders (Single Source of Truth)
// ---------------------------------------------------------------------------

export function buildRegistrationOtpEmail(
  code: string,
  expiryMinutes: number = 15
): { subject: string; text: string; html: string } {
  const subject = "Your Sugo On-the-Go Verification Code";
  const text =
    `Your Sugo On-the-Go verification code is: ${code}\n\n` +
    `This code expires in ${expiryMinutes} minutes.\n` +
    `If you did not request this code, please ignore this email.`;

  const bodyHtml = `
    ${renderCodeBlock(code, expiryMinutes)}
    ${renderSecurityAdvisory(
      "Important",
      "If you did not attempt to sign up for Sugo On-the-Go, please disregard this message. Never share this code with anyone."
    )}
  `;

  const html = renderEmailShell({
    title: "Account Verification",
    subtitle: "Use the 6-digit verification code below to complete your registration.",
    bodyHtml,
    footerNote: "If you did not attempt to sign up for Sugo On-the-Go, please disregard this message.",
    preheader: `Your verification code is ${code}. Valid for ${expiryMinutes} minutes.`,
    categoryBadge: "ACCOUNT VERIFICATION",
  });

  return { subject, text, html };
}

export function buildPasswordResetEmail(
  code: string,
  expiryMinutes: number = 15
): { subject: string; text: string; html: string } {
  const subject = "Your Sugo On-the-Go Password Reset Code";
  const text =
    `Your Sugo On-the-Go password reset code is: ${code}\n\n` +
    `This code expires in ${expiryMinutes} minutes.\n\n` +
    `If you did NOT ask to reset your password, someone may have entered your username. ` +
    `Your password has not changed and no action is needed — but do not share this code with anyone.`;

  const bodyHtml = `
    ${renderCodeBlock(code, expiryMinutes)}
    ${renderSecurityAdvisory(
      "Did not request this?",
      "Someone may have entered your username on the sign-in screen. Your password has not changed and you do not need to take action. Never share this code with anyone — Sugo staff will never ask for it."
    )}
  `;

  const html = renderEmailShell({
    title: "Password Reset Request",
    subtitle: "Use the 6-digit code below to set a new password for your account.",
    bodyHtml,
    footerNote: "Never share this code with anyone. Sugo staff will never ask you for your verification code.",
    preheader: `Your password reset code is ${code}. Valid for ${expiryMinutes} minutes.`,
    categoryBadge: "SECURITY ALERT",
  });

  return { subject, text, html };
}

export function buildSysAdminVerificationLinkEmail(
  verificationLink: string,
  recipientName: string = "System Administrator",
  expiryMinutes: number = 5
): { subject: string; text: string; html: string } {
  const subject = "Verify Your Sugo IT System Administrator Account";
  const text =
    `Hello ${recipientName},\n\n` +
    `You have completed your profile setup for the Sugo IT System Administrator portal.\n\n` +
    `Please click the link below to verify your email and unlock access to the /sysadmin console:\n` +
    `${verificationLink}\n\n` +
    `This link expires in ${expiryMinutes} minutes.\n` +
    `If you did not request this verification, please contact the system owner immediately.`;

  const bodyHtml = `
    <div style="margin: 28px 0; text-align: center;">
      <p style="margin: 0 0 20px 0; font-size: 15px; color: #334155; line-height: 1.6;">
        Welcome <strong>${escapeHtml(recipientName)}</strong>. Please click the button below to verify your email address and activate your System Administrator privileges.
      </p>
      <a href="${escapeHtml(verificationLink)}" target="_blank" style="display: inline-block; background-color: #DC2626; color: #FFFFFF; font-size: 15px; font-weight: 600; text-decoration: none; padding: 14px 28px; border-radius: 8px; letter-spacing: 0.3px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
        Verify &amp; Unlock SysAdmin Portal &rarr;
      </a>
      <p style="margin: 24px 0 8px 0; font-size: 12px; color: #64748B;">
        Or copy and paste this verification URL into your browser:
      </p>
      <p style="margin: 0; font-size: 12px; color: #0284C7; word-break: break-all; font-family: monospace;">
        ${escapeHtml(verificationLink)}
      </p>
    </div>
    ${renderSecurityAdvisory(
      "High-Privilege Security Notice",
      `This link is valid for exactly ${expiryMinutes} minutes and can only be used once. Never forward or disclose this link to anyone. This account holds administrative IT management access.`
    )}
  `;

  const html = renderEmailShell({
    title: "IT Administrator Verification",
    subtitle: "Click the secure button below to verify your email and complete your IT management onboarding.",
    bodyHtml,
    footerNote: "This is an automated administrative notification from Sugo On-the-Go IT Management.",
    preheader: `Click to verify your System Administrator account. Valid for ${expiryMinutes} minutes.`,
    categoryBadge: "IT SECURITY ACCESS",
  });

  return { subject, text, html };
}

export function buildSysAdminUnlockLinkEmail(
  unlockLink: string,
  recipientName: string = "System Administrator",
  expiryMinutes: number = 30
): { subject: string; text: string; html: string } {
  const subject = "Emergency Account Unlock - Sugo IT Administrator Portal";
  const text =
    `Hello ${recipientName},\n\n` +
    `Your System Administrator account has been temporarily locked due to multiple consecutive failed login attempts.\n\n` +
    `If this was you and you wish to unlock your account immediately, please click the emergency unlock link below:\n` +
    `${unlockLink}\n\n` +
    `This emergency unlock link is valid for ${expiryMinutes} minutes.\n` +
    `If you did NOT attempt to sign in, an unauthorized party may be attempting to guess your credentials. Please secure your account immediately.`;

  const bodyHtml = `
    <div style="margin: 28px 0; text-align: center;">
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155; line-height: 1.6;">
        Hello <strong>${escapeHtml(recipientName)}</strong>. Your administrative account has been temporarily locked after 5 consecutive failed authentication attempts.
      </p>
      <p style="margin: 0 0 24px 0; font-size: 14px; color: #64748B; line-height: 1.5;">
        You can wait 30 minutes for the automatic unlock, or click the button below to restore access immediately:
      </p>
      <a href="${escapeHtml(unlockLink)}" target="_blank" style="display: inline-block; background-color: #DC2626; color: #FFFFFF; font-size: 15px; font-weight: 600; text-decoration: none; padding: 14px 28px; border-radius: 8px; letter-spacing: 0.3px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
        Unlock Administrator Account Now &rarr;
      </a>
      <p style="margin: 24px 0 8px 0; font-size: 12px; color: #64748B;">
        Direct unlock URL:
      </p>
      <p style="margin: 0; font-size: 12px; color: #0284C7; word-break: break-all; font-family: monospace;">
        ${escapeHtml(unlockLink)}
      </p>
    </div>
    ${renderSecurityAdvisory(
      "Critical Account Security Notice",
      `If you did not initiate these sign-in attempts, an unauthorized actor may be attempting a brute-force attack against your IT username. We strongly recommend changing your administrative password once signed in.`
    )}
  `;

  const html = renderEmailShell({
    title: "Account Lockout & Emergency Recovery",
    subtitle: "Your IT System Administrator account was locked following multiple failed sign-in attempts.",
    bodyHtml,
    footerNote: "This emergency unlock email was automatically generated by Sugo IT Infrastructure Defense.",
    preheader: `Click to unlock your locked System Administrator account. Link expires in ${expiryMinutes} minutes.`,
    categoryBadge: "ACCOUNT LOCKOUT ALERT",
  });

  return { subject, text, html };
}

export function buildSysAdmin2FaOtpEmail(
  code: string,
  recipientName: string = "System Administrator",
  expiryMinutes: number = 10,
  ipAddress?: string | null,
  deviceInfo?: string | null
): { subject: string; text: string; html: string } {
  const subject = `Your Sugo IT SysAdmin 2FA Security Code: ${code}`;
  const text =
    `Hello ${recipientName},\n\n` +
    `A sign-in attempt was initiated for your System Administrator account from an unrecognized device or location.\n\n` +
    `Your Two-Factor Authentication (2FA) verification code is: ${code}\n\n` +
    `This code is valid for ${expiryMinutes} minutes.\n` +
    (ipAddress ? `IP Address: ${ipAddress}\n` : "") +
    (deviceInfo ? `Device: ${deviceInfo}\n\n` : "\n") +
    `Never share this code with anyone. Sugo staff will never ask for your verification code.`;

  const bodyHtml = `
    <div style="margin: 28px 0; text-align: center;">
      <p style="margin: 0 0 20px 0; font-size: 15px; color: #334155; line-height: 1.6;">
        Hello <strong>${escapeHtml(recipientName)}</strong>. Please enter the 6-digit verification code below to verify your identity and access the IT Administration portal.
      </p>
      <div style="display: inline-block; background-color: #0F172A; border: 1px solid #334155; border-radius: 10px; padding: 18px 36px; margin: 8px 0 20px 0;">
        <span style="font-family: 'Courier New', Courier, monospace; font-size: 34px; font-weight: 700; letter-spacing: 8px; color: #38BDF8;">
          ${escapeHtml(code)}
        </span>
      </div>
      <p style="margin: 0; font-size: 13px; color: #64748B;">
        This code expires in <strong>${expiryMinutes} minutes</strong>.
      </p>
    </div>
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 20px 0; background-color: #F1F5F9; border-radius: 8px; padding: 14px 18px;">
      <tr>
        <td style="font-size: 13px; color: #475569; line-height: 1.6;">
          <strong>Sign-in details:</strong><br />
          &bull; IP Address: <span style="font-family: monospace;">${escapeHtml(ipAddress || "Unknown")}</span><br />
          &bull; Device: ${escapeHtml(deviceInfo || "Unrecognized Browser / Device")}
        </td>
      </tr>
    </table>
    ${renderSecurityAdvisory(
      "Administrative Privilege Protection",
      "Two-factor authentication is required for all administrative logins from unrecognized IP addresses or browsers to protect server infrastructure. Never share this code."
    )}
  `;

  const html = renderEmailShell({
    title: "Administrative Two-Factor Authentication",
    subtitle: "Enter the one-time security code to authorize this IT management session.",
    bodyHtml,
    footerNote: "This security code was requested by an administrator login attempt.",
    preheader: `Your IT SysAdmin 2FA code is ${code}. Valid for ${expiryMinutes} minutes.`,
    categoryBadge: "TWO-FACTOR AUTHENTICATION",
  });

  return { subject, text, html };
}

export function buildSysAdminSecurityAlertEmail(
  title: string,
  message: string,
  details: {
    adminUsername: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    action?: string;
  }
): { subject: string; text: string; html: string } {
  const subject = `[SECURITY ALERT] Sugo IT Portal: ${title}`;
  const text =
    `SUGO IT MANAGEMENT SECURITY ALERT\n\n` +
    `Event: ${title}\n` +
    `Administrator: ${details.adminUsername}\n` +
    (details.action ? `Action: ${details.action}\n` : "") +
    (details.ipAddress ? `IP Address: ${details.ipAddress}\n` : "") +
    (details.userAgent ? `User Agent: ${details.userAgent}\n` : "") +
    `Timestamp: ${new Date().toUTCString()}\n\n` +
    `Message: ${message}\n\n` +
    `Please inspect the Audit Logs in the SysAdmin Portal if this action was unexpected.`;

  const bodyHtml = `
    <div style="margin: 20px 0;">
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #1E293B; line-height: 1.6;">
        ${escapeHtml(message)}
      </p>
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 14px 18px; margin: 16px 0;">
        <tr>
          <td style="font-size: 13px; color: #334155; line-height: 1.8;">
            <strong>Event Details:</strong><br />
            &bull; <strong>Administrator:</strong> ${escapeHtml(details.adminUsername)}<br />
            ${details.action ? `&bull; <strong>Action:</strong> ${escapeHtml(details.action)}<br />` : ""}
            &bull; <strong>IP Address:</strong> <span style="font-family: monospace;">${escapeHtml(details.ipAddress || "Unknown")}</span><br />
            &bull; <strong>Device:</strong> <span style="font-size: 12px; color: #64748B;">${escapeHtml(details.userAgent || "Unknown")}</span><br />
            &bull; <strong>Time:</strong> ${escapeHtml(new Date().toUTCString())}
          </td>
        </tr>
      </table>
    </div>
    ${renderSecurityAdvisory(
      "IT Infrastructure Security Notice",
      "This high-priority alert was dispatched to all registered System Administrators. If you did not perform or authorize this action, immediately access the IT console, terminate active sessions, and review audit logs."
    )}
  `;

  const html = renderEmailShell({
    title,
    subtitle: "Security event detected on the Sugo Express IT management infrastructure.",
    bodyHtml,
    footerNote: "Automated alert from Sugo IT Security Monitoring.",
    preheader: `[Security Alert] ${title} - Administrator: ${details.adminUsername}`,
    categoryBadge: "SECURITY ADVISORY",
  });

  return { subject, text, html };
}

