// Shared chrome for transactional email, so every message the system sends
// looks like it came from the same product.
//
// The markup is lifted verbatim from the customer-registration OTP mail in
// services/emailVerificationService.ts. That service still carries its own
// inline copy deliberately — it is a working, shipped path and this change had
// no reason to touch it. If the branding here is ever revised, revise it there
// too, or fold that service onto renderEmailShell in the same commit.

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
}

export function renderEmailShell({ title, subtitle, bodyHtml, footerNote }: EmailShellOptions): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${escapeHtml(title)}</title>
    </head>
    <body style="margin: 0; padding: 24px; background-color: #F8F9FA; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
      <div style="max-width: 480px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; padding: 32px; border: 1px solid #E5E7EB; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="display: inline-block; background-color: #F62459; color: #FFFFFF; font-weight: bold; font-size: 18px; padding: 8px 18px; border-radius: 9999px; letter-spacing: 1px;">
            SUGO EXPRESS
          </div>
          <h2 style="color: #111827; margin-top: 16px; margin-bottom: 8px; font-size: 22px;">${escapeHtml(title)}</h2>
          <p style="color: #6B7280; font-size: 14px; margin: 0;">${escapeHtml(subtitle)}</p>
        </div>

        ${bodyHtml}

        <div style="border-top: 1px solid #F3F4F6; padding-top: 18px; text-align: center;">
          <p style="color: #9CA3AF; font-size: 12px; margin: 0;">${escapeHtml(footerNote)}</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

// The big monospace code block used by every OTP mail.
export function renderCodeBlock(code: string, expiryMinutes: number): string {
  return `
        <div style="background-color: #FFEEF3; border: 1.5px dashed #F62459; border-radius: 12px; padding: 18px; text-align: center; margin: 24px 0;">
          <span style="font-size: 32px; font-weight: 800; color: #F62459; letter-spacing: 10px; font-family: monospace;">${escapeHtml(code)}</span>
        </div>

        <p style="color: #4B5563; font-size: 13px; text-align: center; margin-bottom: 24px;">
          &#9201; This code will expire in <strong>${expiryMinutes} minutes</strong>.
        </p>
  `;
}

// Label/value rows for the sign-in alert.
export function renderDetailRows(rows: Array<{ label: string; value: string }>): string {
  const cells = rows
    .map(
      ({ label, value }) => `
          <tr>
            <td style="padding: 8px 0; color: #6B7280; font-size: 13px; vertical-align: top; white-space: nowrap;">${escapeHtml(label)}</td>
            <td style="padding: 8px 0 8px 16px; color: #111827; font-size: 13px; font-weight: 600; word-break: break-word;">${escapeHtml(value)}</td>
          </tr>`
    )
    .join("");

  return `
        <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 8px 16px; margin: 20px 0;">
          <tbody>${cells}</tbody>
        </table>
  `;
}
