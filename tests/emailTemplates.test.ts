import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  renderEmailShell,
  renderCodeBlock,
  renderSecurityAdvisory,
  renderDetailRows,
  buildRegistrationOtpEmail,
  buildPasswordResetEmail,
} from "../src/lib/emailTemplates.js";

describe("emailTemplates — Design System & Security", () => {
  it("escapes malicious HTML injection characters in user-controlled inputs", () => {
    const malicious = '<script>alert("hacked")</script>&"\'';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("&amp;");
    expect(escaped).toContain("&quot;");
    expect(escaped).toContain("&#39;");
  });

  it("builds customer registration OTP email with professional structure and zero nested cards", () => {
    const { subject, text, html } = buildRegistrationOtpEmail("482910", 15);

    expect(subject).toBe("Your Sugo On-the-Go Verification Code");
    expect(text).toContain("482910");
    expect(text).toContain("15 minutes");

    // HTML must contain brand header and tracking
    expect(html).toContain("SUGO");
    expect(html).toContain("EXPRESS");
    expect(html).toContain("ACCOUNT VERIFICATION");

    // Code presentation checks (large monospace digits, zero coupon-style dashed boxes)
    expect(html).toContain("482910");
    expect(html).toContain("Verification Code");
    expect(html).not.toContain("border: 1.5px dashed");
    expect(html).not.toContain("border-radius: 9999px");

    // Security advisory and footer
    expect(html).toContain("Important");
    expect(html).toContain("Tacurong City, Sultan Kudarat, Philippines");
  });

  it("builds customer password reset email with clear security warning", () => {
    const { subject, text, html } = buildPasswordResetEmail("918234", 15);

    expect(subject).toBe("Your Sugo On-the-Go Password Reset Code");
    expect(text).toContain("918234");
    expect(text).toContain("If you did NOT ask to reset your password");

    // HTML assertions
    expect(html).toContain("Password Reset Request");
    expect(html).toContain("SECURITY ALERT");
    expect(html).toContain("918234");
    expect(html).toContain("Did not request this?");
  });

  it("renders detail rows as a clean table without nested card wrappers", () => {
    const rows = [
      { label: "Account", value: "admin_test" },
      { label: "IP Address", value: "192.168.1.10" },
      { label: "Device", value: "Chrome on Windows 11" },
    ];

    const html = renderDetailRows(rows);
    expect(html).toContain("Account");
    expect(html).toContain("admin_test");
    expect(html).toContain("192.168.1.10");
    expect(html).toContain("<table");
    // Should NOT use heavy nested card styles
    expect(html).not.toContain("border-radius: 16px");
  });

  it("renders email shell with hidden preheader preview text", () => {
    const html = renderEmailShell({
      title: "Test Security Alert",
      subtitle: "Testing preheader preview",
      bodyHtml: "<p>Content</p>",
      footerNote: "Test footer",
      preheader: "Preview this in inbox",
      categoryBadge: "SECURITY TEST",
    });

    expect(html).toContain("Preview this in inbox");
    expect(html).toContain("display: none;");
    expect(html).toContain("SUGO");
    expect(html).toContain("SECURITY TEST");
    expect(html).toContain("Test Security Alert");
    expect(html).toContain("Content");
    expect(html).toContain("Test footer");
  });
});
