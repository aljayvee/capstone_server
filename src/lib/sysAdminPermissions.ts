/**
 * Systematic catalog of the 19 granular SysAdmin capabilities across 5 areas,
 * with dependency rules and the Read-Only Monitoring baseline for newly
 * provisioned secondary IT Admins.
 */

export const SYSADMIN_PERMISSION_AREAS = [
  "Monitoring & Logs",
  "Users & Sessions",
  "Security & Threats",
  "DevOps & Infrastructure",
  "App Releases & IT Staff",
] as const;

export type SysAdminPermissionArea = (typeof SYSADMIN_PERMISSION_AREAS)[number];

export interface SysAdminPermissionDef {
  readonly key: string;
  readonly area: SysAdminPermissionArea;
  readonly label: string;
  readonly note: string;
  readonly requires?: readonly string[];
  readonly baselineReadOnly?: boolean;
}

export const SYSADMIN_PERMISSIONS: readonly SysAdminPermissionDef[] = [
  // ── 1. Monitoring & Logs (5 — Read-Only baseline for secondary IT Admins) ──
  {
    key: "telemetry.view",
    area: "Monitoring & Logs",
    label: "Telemetry & Alert Status",
    note: "View server health metrics, portal maintenance states, and Telegram alert delivery history.",
    baselineReadOnly: true,
  },
  {
    key: "traffic.view",
    area: "Monitoring & Logs",
    label: "Web Traffic",
    note: "View Nginx traffic telemetry and embedded GoAccess analytics reports.",
    baselineReadOnly: true,
  },
  {
    key: "logs.view",
    area: "Monitoring & Logs",
    label: "Server Logs",
    note: "View PM2 backend stdout/stderr and Nginx access/error log streams.",
    baselineReadOnly: true,
  },
  {
    key: "audit.view",
    area: "Monitoring & Logs",
    label: "Audit Logs",
    note: "View authentication, account modification, security threat, activity, and report print audit logs.",
    baselineReadOnly: true,
  },
  {
    key: "incidents.view",
    area: "Monitoring & Logs",
    label: "Incidents View",
    note: "View system incident timelines, status updates, and postmortem notes.",
    baselineReadOnly: true,
  },

  // ── 2. Users & Sessions (3) ──
  {
    key: "users.view",
    area: "Users & Sessions",
    label: "View Accounts & Sessions",
    note: "View monitored user accounts and inspect active device sessions.",
  },
  {
    key: "users.sessions",
    area: "Users & Sessions",
    label: "Terminate Sessions",
    note: "Force-terminate active login sessions for monitored user accounts.",
    requires: ["users.view"],
  },
  {
    key: "users.status",
    area: "Users & Sessions",
    label: "Change Account Status",
    note: "Suspend, lock, deactivate, or reactivate non-root user accounts (Main Owner is protected).",
    requires: ["users.view"],
  },

  // ── 3. Security & Threats (2) ──
  {
    key: "threats.view",
    area: "Security & Threats",
    label: "View Blocklist/Whitelist",
    note: "View threat telemetry overview, active IP bans, and whitelisted IP entries.",
  },
  {
    key: "threats.manage",
    area: "Security & Threats",
    label: "Manage IP Blocklist/Whitelist",
    note: "Manually ban or unblock IP addresses and add or remove IP whitelist entries.",
    requires: ["threats.view"],
  },

  // ── 4. DevOps & Infrastructure (5) ──
  {
    key: "incidents.manage",
    area: "DevOps & Infrastructure",
    label: "Manage Incidents",
    note: "Create, update, and resolve operational incidents and timeline summaries.",
    requires: ["incidents.view"],
  },
  {
    key: "devops.backups.view",
    area: "DevOps & Infrastructure",
    label: "View Backups & Off-site Status",
    note: "Inspect local database backup inventory, off-site R2 status, and restore test history.",
  },
  {
    key: "devops.backups.manage",
    area: "DevOps & Infrastructure",
    label: "Trigger/Download/Verify/Delete Backups",
    note: "Create manual snapshots, download backup archives, start restore checks, or delete backups.",
    requires: ["devops.backups.view"],
  },
  {
    key: "devops.services",
    area: "DevOps & Infrastructure",
    label: "Maintenance Mode, Service Restarts & Test Alerts",
    note: "Toggle portal maintenance/live advisories, restart PM2/Nginx services, and dispatch test alerts.",
  },
  {
    key: "devops.features",
    area: "DevOps & Infrastructure",
    label: "Feature & Simulation Toggles",
    note: "Toggle Kuya Sugo copilot, Dispatcher AI suggestions, and simulated 500 error overlays.",
  },

  // ── 5. App Releases & IT Staff (4) ──
  {
    key: "releases.view",
    area: "App Releases & IT Staff",
    label: "View App Releases",
    note: "View customer and rider APK release versions, changelogs, and artifacts.",
  },
  {
    key: "releases.manage",
    area: "App Releases & IT Staff",
    label: "Upload & Edit APK Releases",
    note: "Upload new APK builds and edit release notes or minimum Android metadata.",
    requires: ["releases.view"],
  },
  {
    key: "staff.view",
    area: "App Releases & IT Staff",
    label: "View IT Staff",
    note: "View the IT Administrator roster and effective access status.",
  },
  {
    key: "staff.manage",
    area: "App Releases & IT Staff",
    label: "Provision IT Staff",
    note: "Provision new secondary IT Administrator accounts.",
    requires: ["staff.view"],
  },
] as const;

const BY_KEY = new Map<string, SysAdminPermissionDef>(
  SYSADMIN_PERMISSIONS.map((p) => [p.key, p])
);

export const ALL_SYSADMIN_PERMISSION_KEYS: readonly string[] = SYSADMIN_PERMISSIONS.map((p) => p.key);

export const READ_ONLY_BASELINE_KEYS: readonly string[] = SYSADMIN_PERMISSIONS
  .filter((p) => p.baselineReadOnly)
  .map((p) => p.key);

export function getSysAdminPermission(key: string): SysAdminPermissionDef | undefined {
  return BY_KEY.get(key);
}

/**
 * Validates dependency constraints on a full set of SysAdmin permission keys.
 * Returns any missing dependency pairs so callers receive an explicit error.
 */
export function missingSysAdminRequires(
  keys: Iterable<string>
): Array<{ key: string; requires: string }> {
  const held = new Set(keys);
  const missing: Array<{ key: string; requires: string }> = [];
  for (const key of held) {
    const def = BY_KEY.get(key);
    if (!def?.requires) continue;
    for (const req of def.requires) {
      if (!held.has(req)) {
        missing.push({ key, requires: req });
      }
    }
  }
  return missing;
}
