import { prisma } from "../lib/prisma.js";
import { sendEmail } from "../lib/mailer.js";
import { DEVELOPER_FEEDBACK_EMAIL } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { CreateFeedbackInput, ResolveFeedbackInput } from "../validators/feedbackValidators.js";
import type { FeedbackCategory, FeedbackStatus } from "@prisma/client";

function generateRefCode(): string {
  const dateSegment = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  return `FB-${dateSegment}-${randomSuffix}`;
}

function renderStars(rating: number): string {
  return "★".repeat(Math.min(Math.max(rating, 1), 5)) + "☆".repeat(Math.max(0, 5 - rating));
}

export async function submitFeedback(input: CreateFeedbackInput, customerId?: number) {
  const refCode = generateRefCode();

  // 1. Fetch customer details if authenticated
  let customerInfo: { name?: string; email?: string; phone?: string } | null = null;
  if (customerId) {
    try {
      const customer = await prisma.customerAccount.findUnique({
        where: { id: customerId },
        include: { information: true },
      });
      if (customer) {
        const name = [customer.information?.firstName, customer.information?.lastName].filter(Boolean).join(" ");
        customerInfo = {
          name: name || customer.username,
          email: customer.email,
          phone: customer.information?.phone,
        };
      }
    } catch (err) {
      logger.warn(`[FeedbackService] Failed to load customer info for id ${customerId}:`, err);
    }
  }

  const effectiveEmail = input.contactEmail || customerInfo?.email || null;
  const effectivePhone = input.contactPhone || customerInfo?.phone || null;

  // 2. Persist record in MariaDB first (Zero-Data-Loss guarantee)
  const feedback = await prisma.customerFeedback.create({
    data: {
      refCode,
      customerId: customerId || null,
      category: input.category as FeedbackCategory,
      rating: input.rating,
      subject: input.subject,
      message: input.message,
      contactEmail: effectiveEmail,
      contactPhone: effectivePhone,
      appVersion: input.appVersion || null,
      platform: input.platform || null,
      deviceModel: input.deviceModel || null,
      osVersion: input.osVersion || null,
      status: "NEW",
    },
  });

  // 3. Dispatch developer email alert asynchronously
  void (async () => {
    try {
      const starsDisplay = renderStars(input.rating);
      const emailSubject = `🚨 [Sugo Feedback ${refCode}] [${input.category}] ${input.subject}`;

      const textBody = [
        `CUSTOMER FEEDBACK ALERT (${refCode})`,
        `Category: ${input.category}`,
        `Rating: ${starsDisplay} (${input.rating}/5)`,
        `Subject: ${input.subject}`,
        `Message:`,
        input.message,
        ``,
        `Customer Details:`,
        `- Name: ${customerInfo?.name || "Guest Customer"}`,
        `- Contact Email: ${effectiveEmail || "None provided"}`,
        `- Contact Phone: ${effectivePhone || "None provided"}`,
        `- Customer ID: ${customerId || "Unauthenticated"}`,
        ``,
        `Device Telemetry:`,
        `- Platform: ${input.platform || "Unknown"}`,
        `- Device: ${input.deviceModel || "Unknown"}`,
        `- OS Version: ${input.osVersion || "Unknown"}`,
        `- App Version: ${input.appVersion || "Unknown"}`,
        `- Submitted At: ${new Date().toISOString()}`,
      ].join("\n");

      const htmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #E2E8F0; border-radius: 12px; background-color: #FFFFFF;">
          <div style="background-color: #0B132B; padding: 16px 20px; border-radius: 8px 8px 0 0; color: #FFFFFF;">
            <h2 style="margin: 0; font-size: 18px; color: #F62459;">SUGO EXPRESS · CUSTOMER FEEDBACK</h2>
            <p style="margin: 4px 0 0; font-size: 12px; color: #94A3B8;">Reference Ticket: <strong>${refCode}</strong></p>
          </div>
          <div style="padding: 20px;">
            <div style="margin-bottom: 16px;">
              <span style="display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: bold; background-color: #F1F5F9; color: #1E293B;">${input.category}</span>
              <span style="display: inline-block; margin-left: 8px; color: #F59E0B; font-size: 16px;">${starsDisplay}</span>
            </div>
            <h3 style="margin: 0 0 10px; font-size: 16px; color: #0F172A;">${escapeHtml(input.subject)}</h3>
            <div style="background-color: #F8FAFC; border-left: 4px solid #F62459; padding: 12px 16px; border-radius: 4px; font-size: 14px; color: #334155; line-height: 1.5; margin-bottom: 20px;">
              ${escapeHtml(input.message).replace(/\n/g, "<br/>")}
            </div>

            <table style="width: 100%; border-collapse: collapse; font-size: 12px; color: #475569; margin-bottom: 20px;">
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid #F1F5F9; font-weight: bold;">Customer:</td>
                <td style="padding: 6px 0; border-bottom: 1px solid #F1F5F9;">${customerInfo?.name || "Guest Customer"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid #F1F5F9; font-weight: bold;">Contact Email:</td>
                <td style="padding: 6px 0; border-bottom: 1px solid #F1F5F9;">${effectiveEmail || "N/A"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid #F1F5F9; font-weight: bold;">Contact Phone:</td>
                <td style="padding: 6px 0; border-bottom: 1px solid #F1F5F9;">${effectivePhone || "N/A"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid #F1F5F9; font-weight: bold;">Device & OS:</td>
                <td style="padding: 6px 0; border-bottom: 1px solid #F1F5F9;">${input.deviceModel || "Unknown"} · ${input.platform || "Unknown"} (${input.osVersion || "Unknown"})</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: bold;">App Version:</td>
                <td style="padding: 6px 0;">v${input.appVersion || "1.0.0"}</td>
              </tr>
            </table>

            <p style="font-size: 11px; color: #94A3B8; text-align: center; margin: 0;">
              This notification was automatically dispatched to the development engineering team.
            </p>
          </div>
        </div>
      `;

      const emailSent = await sendEmail(DEVELOPER_FEEDBACK_EMAIL, emailSubject, textBody, htmlBody);
      if (emailSent) {
        await prisma.customerFeedback.update({
          where: { id: feedback.id },
          data: { emailDispatched: true },
        });
      }
    } catch (mailErr) {
      logger.error(`[FeedbackService] Failed to send developer alert email for ${refCode}:`, mailErr);
    }
  })();

  // 4. Send customer acknowledgment if email is available
  if (effectiveEmail) {
    void (async () => {
      try {
        const customerAckSubject = `Thank you for your feedback! [${refCode}]`;
        const customerAckText = `Hi ${customerInfo?.name || "there"},\n\nThank you for reaching out to Sugo Express. We have received your feedback (${refCode}):\n\n"${input.subject}"\n\nOur development and operational teams review customer submissions diligently to improve your experience in Tacurong City.\n\nWarm regards,\nSugo Express Team`;
        await sendEmail(effectiveEmail, customerAckSubject, customerAckText);
      } catch (custMailErr) {
        logger.warn(`[FeedbackService] Could not send customer ack email:`, custMailErr);
      }
    })();
  }

  return feedback;
}

export async function listFeedbacks(filters: {
  status?: FeedbackStatus;
  category?: FeedbackCategory;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const { status, category, search, limit = 50, offset = 0 } = filters;

  const where: any = {};
  if (status) where.status = status;
  if (category) where.category = category;
  if (search) {
    where.OR = [
      { refCode: { contains: search } },
      { subject: { contains: search } },
      { message: { contains: search } },
      { contactEmail: { contains: search } },
    ];
  }

  const [total, items] = await Promise.all([
    prisma.customerFeedback.count({ where }),
    prisma.customerFeedback.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 100),
      skip: offset,
      include: {
        customer: {
          select: {
            id: true,
            username: true,
            email: true,
            information: {
              select: {
                firstName: true,
                lastName: true,
                phone: true,
              },
            },
          },
        },
        readByUser: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    }),
  ]);

  return { total, items, limit, offset };
}

export async function getFeedbackById(id: number) {
  return prisma.customerFeedback.findUnique({
    where: { id },
    include: {
      customer: {
        select: {
          id: true,
          username: true,
          email: true,
          information: true,
        },
      },
      readByUser: {
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });
}

export async function markFeedbackRead(id: number, staffUserId: number) {
  return prisma.customerFeedback.update({
    where: { id },
    data: {
      readAt: new Date(),
      readByUserId: staffUserId,
      status: "IN_REVIEW",
    },
  });
}

export async function resolveFeedback(id: number, input: ResolveFeedbackInput, staffUserId: number) {
  return prisma.customerFeedback.update({
    where: { id },
    data: {
      status: input.status,
      developerNotes: input.developerNotes,
      resolvedAt: new Date(),
      readAt: new Date(),
      readByUserId: staffUserId,
    },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
