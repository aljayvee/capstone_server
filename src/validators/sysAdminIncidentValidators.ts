import { z } from "zod";
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES } from "../services/sysAdminIncidentService.js";

const REPORT_TEXT_MAX = 5000;
/** A clock a few minutes ahead of the server's is not a typo; an hour is. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const reportText = (label: string) =>
  z
    .string({ message: `${label} must be text.` })
    .max(REPORT_TEXT_MAX, `${label} is longer than ${REPORT_TEXT_MAX} characters.`)
    .nullable()
    .optional();

const notInFuture = (label: string) =>
  z.coerce
    .date({ message: `${label} is not a valid date and time.` })
    .refine((d) => d.getTime() <= Date.now() + FUTURE_SKEW_MS, `${label} cannot be in the future.`);

const title = z
  .string({ message: "Give the incident a short title." })
  .trim()
  .min(3, "Give the incident a short title (at least 3 characters).")
  .max(255, "Keep the title under 255 characters.");

export const createIncidentSchema = z
  .object({
    title,
    severity: z.enum(INCIDENT_SEVERITIES, { message: "Pick a severity." }).default("HIGH"),
    startedAt: notInFuture("Start time"),
    impact: reportText("Impact"),
  })
  .strict();

export const updateIncidentSchema = z
  .object({
    title: title.optional(),
    severity: z.enum(INCIDENT_SEVERITIES, { message: "Pick a severity." }).optional(),
    status: z.enum(INCIDENT_STATUSES, { message: "Unknown incident status." }).optional(),
    impact: reportText("Impact"),
    cause: reportText("Cause"),
    fix: reportText("Fix"),
    prevention: reportText("Prevention"),
    recoveredAt: notInFuture("Recovered time").nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "Nothing to change.");

export const listIncidentsQuerySchema = z.object({
  view: z.enum(["active", "resolved", "all"]).default("active"),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});

export const incidentIdSchema = z.coerce
  .number({ message: "Incident id must be a number." })
  .int()
  .positive("Incident id must be a number.");
