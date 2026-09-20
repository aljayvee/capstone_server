import { prisma } from "../lib/prisma.js";
import { ServiceError } from "./ServiceError.js";

// 1. Auth & Session Audit
export interface ListAuthAuditFilters {
  role?: string;
  status?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

export async function listAuthAuditLogs(filters: ListAuthAuditFilters = {}) {
  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(100, Math.max(1, filters.limit || 25));
  const skip = (page - 1) * limit;

  const where: any = {};

  if (filters.role && filters.role !== "ALL") {
    where.role = filters.role.toUpperCase();
  }

  if (filters.status && filters.status !== "ALL") {
    where.status = filters.status;
  }

  if (filters.startDate || filters.endDate) {
    where.createdAt = {};
    if (filters.startDate) {
      where.createdAt.gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      const end = new Date(filters.endDate);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  if (filters.search?.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { ipAddress: { contains: term } },
      { userAgent: { contains: term } },
      { deviceInfo: { contains: term } },
      { status: { contains: term } },
      { revokedReason: { contains: term } },
    ];
  }

  const [logs, total] = await Promise.all([
    prisma.accountLoginLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.accountLoginLog.count({ where }),
  ]);

  // Resolve user identity (username, name)
  const staffIds = logs.filter((l) => l.role !== "CUSTOMER").map((l) => l.userId);
  const customerIds = logs.filter((l) => l.role === "CUSTOMER").map((l) => l.userId);

  const [staffUsers, customers] = await Promise.all([
    staffIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, username: true, firstName: true, lastName: true },
        })
      : [],
    customerIds.length > 0
      ? prisma.customerAccount.findMany({
          where: { id: { in: customerIds } },
          select: {
            id: true,
            username: true,
            information: { select: { firstName: true, lastName: true } },
          },
        })
      : [],
  ]);

  const staffMap = new Map(staffUsers.map((u) => [u.id, u]));
  const customerMap = new Map(customers.map((c) => [c.id, c]));

  const enrichedLogs = logs.map((log) => {
    let username = "Unknown";
    let name = "Unknown";

    if (log.role === "CUSTOMER") {
      const c = customerMap.get(log.userId);
      if (c) {
        username = c.username;
        name = c.information ? `${c.information.firstName} ${c.information.lastName}` : c.username;
      }
    } else {
      const s = staffMap.get(log.userId);
      if (s) {
        username = s.username;
        name = `${s.firstName} ${s.lastName}`;
      }
    }

    return {
      id: log.id,
      userId: log.userId,
      username,
      name,
      role: log.role,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      deviceInfo: log.deviceInfo,
      status: log.status,
      sessionId: log.sessionId,
      isOnline: log.isOnline,
      revokedAt: log.revokedAt,
      revokedReason: log.revokedReason,
      createdAt: log.createdAt,
    };
  });

  return {
    logs: enrichedLogs,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// 2. Account Modifications Audit
export interface ListModificationAuditFilters {
  role?: string;
  fieldModified?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export async function listAccountModificationLogs(filters: ListModificationAuditFilters = {}) {
  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(100, Math.max(1, filters.limit || 25));
  const skip = (page - 1) * limit;

  const where: any = {};

  if (filters.role && filters.role !== "ALL") {
    where.role = filters.role.toUpperCase();
  }

  if (filters.fieldModified && filters.fieldModified !== "ALL") {
    where.fieldModified = filters.fieldModified;
  }

  if (filters.search?.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { fieldModified: { contains: term } },
      { verifiedVia: { contains: term } },
      { ipAddress: { contains: term } },
    ];
  }

  const [logs, total] = await Promise.all([
    prisma.accountModificationLog.findMany({
      where,
      include: {
        user: { select: { id: true, username: true, firstName: true, lastName: true } },
        customer: {
          select: {
            id: true,
            username: true,
            information: { select: { firstName: true, lastName: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.accountModificationLog.count({ where }),
  ]);

  // Redact passwords / hashes strictly
  const sanitizedLogs = logs.map((log) => {
    const isPasswordField =
      log.fieldModified.toLowerCase().includes("password") ||
      log.fieldModified.toLowerCase().includes("hash");

    let username = "Unknown";
    let name = "Unknown";

    if (log.user) {
      username = log.user.username;
      name = `${log.user.firstName} ${log.user.lastName}`;
    } else if (log.customer) {
      username = log.customer.username;
      name = log.customer.information
        ? `${log.customer.information.firstName} ${log.customer.information.lastName}`
        : log.customer.username;
    }

    return {
      id: log.id,
      role: log.role,
      targetId: log.userId || log.customerId,
      username,
      name,
      fieldModified: log.fieldModified,
      oldValue: isPasswordField ? "[REDACTED_PASSWORD_HASH]" : log.oldValue,
      newValue: isPasswordField ? "[REDACTED_PASSWORD_HASH]" : log.newValue,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      verifiedVia: log.verifiedVia,
      createdAt: log.createdAt,
    };
  });

  return {
    logs: sanitizedLogs,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// 3. Security & Threat Events Audit
export interface ListSecurityAuditFilters {
  severity?: string; // "ALL" | "CRITICAL" | "WARNING" | "INFO"
  search?: string;
  page?: number;
  limit?: number;
}

export async function listSecurityThreatLogs(filters: ListSecurityAuditFilters = {}) {
  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(100, Math.max(1, filters.limit || 25));

  // Query PasswordResetAttempt
  const resetAttempts = await prisma.passwordResetAttempt.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      customer: {
        select: {
          id: true,
          username: true,
          information: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  // Query SysAdmin Interventions (session termination, status locks)
  const adminInterventions = await prisma.accountModificationLog.findMany({
    where: {
      OR: [
        { verifiedVia: { contains: "SYSADMIN" } },
        { fieldModified: "session_eviction" },
        { fieldModified: "account_status" },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      user: { select: { username: true, firstName: true, lastName: true } },
      customer: {
        select: {
          username: true,
          information: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  // Map into unified Security Event items
  type UnifiedSecurityItem = {
    id: string;
    eventType: string;
    severity: "CRITICAL" | "WARNING" | "INFO";
    targetIdentifier: string;
    targetName: string;
    details: string;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
  };

  const events: UnifiedSecurityItem[] = [];

  for (const a of resetAttempts) {
    let severity: "CRITICAL" | "WARNING" | "INFO" = "INFO";
    if (["HONEYPOT", "THROTTLED"].includes(a.outcome)) {
      severity = "CRITICAL";
    } else if (["UNKNOWN_ACCOUNT", "CODE_REJECTED"].includes(a.outcome)) {
      severity = "WARNING";
    }

    const targetName = a.customer?.information
      ? `${a.customer.information.firstName} ${a.customer.information.lastName}`
      : a.customer?.username || a.identifier;

    events.push({
      id: `reset-${a.id}`,
      eventType: `PWD_RESET_${a.outcome}`,
      severity,
      targetIdentifier: a.identifier,
      targetName,
      details: `Password reset attempt resulted in ${a.outcome}`,
      ipAddress: a.ipAddress,
      userAgent: a.userAgent,
      createdAt: a.createdAt,
    });
  }

  for (const m of adminInterventions) {
    let severity: "CRITICAL" | "WARNING" | "INFO" = "WARNING";
    if (m.newValue === "Locked" || m.fieldModified === "session_eviction") {
      severity = "CRITICAL";
    } else if (m.newValue === "Suspended") {
      severity = "WARNING";
    } else {
      severity = "INFO";
    }

    const username = m.user?.username || m.customer?.username || "Unknown";
    const name = m.user
      ? `${m.user.firstName} ${m.user.lastName}`
      : m.customer?.information
      ? `${m.customer.information.firstName} ${m.customer.information.lastName}`
      : username;

    events.push({
      id: `mod-${m.id}`,
      eventType: m.fieldModified === "session_eviction" ? "SESSION_REVOCATION" : "ACCOUNT_STATUS_CHANGE",
      severity,
      targetIdentifier: `@${username} (${m.role})`,
      targetName: name,
      details: `${m.fieldModified}: changed from '${m.oldValue}' to '${m.newValue}' (${m.verifiedVia})`,
      ipAddress: m.ipAddress,
      userAgent: m.userAgent,
      createdAt: m.createdAt,
    });
  }

  // Sort by date desc
  events.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  // Filter
  let filtered = events;
  if (filters.severity && filters.severity !== "ALL") {
    filtered = filtered.filter((e) => e.severity === filters.severity);
  }

  if (filters.search?.trim()) {
    const term = filters.search.trim().toLowerCase();
    filtered = filtered.filter(
      (e) =>
        e.eventType.toLowerCase().includes(term) ||
        e.targetIdentifier.toLowerCase().includes(term) ||
        e.details.toLowerCase().includes(term) ||
        (e.ipAddress && e.ipAddress.includes(term))
    );
  }

  const total = filtered.length;
  const paginated = filtered.slice((page - 1) * limit, page * limit);

  return {
    events: paginated,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// 4. System Lifecycle & Errand State Activity Stream (Strict Privacy: NO CHATS, NO BASKET ITEMS)
export interface ListSystemActivityFilters {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export async function listSystemActivityLogs(filters: ListSystemActivityFilters = {}) {
  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(100, Math.max(1, filters.limit || 25));
  const skip = (page - 1) * limit;

  const where: any = {};

  if (filters.status && filters.status !== "ALL") {
    where.status = filters.status;
  }

  if (filters.search?.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { id: { contains: term } },
      { category: { contains: term } },
      { pickupAddress: { contains: term } },
      { deliveryAddress: { contains: term } },
    ];
  }

  // Fetch only high-level errand lifecycle entities
  const [errands, total] = await Promise.all([
    prisma.errand.findMany({
      where,
      select: {
        id: true,
        category: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        pickupAddress: true,
        deliveryAddress: true,
        customerId: true,
        riderId: true,
        dispatchLogs: {
          select: {
            dispatcherId: true,
            dispatchedAt: true,
            dispatcher: { select: { username: true, firstName: true, lastName: true } },
          },
          orderBy: { dispatchedAt: "desc" },
          take: 1,
        },
        rider: { select: { username: true, firstName: true, lastName: true } },
      },
      orderBy: { updatedAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.errand.count({ where }),
  ]);

  const activities = errands.map((e) => {
    const latestDispatch = e.dispatchLogs[0];
    const dispatcherName = latestDispatch?.dispatcher
      ? `${latestDispatch.dispatcher.firstName} ${latestDispatch.dispatcher.lastName}`
      : "Unassigned";
    const riderName = e.rider ? `${e.rider.firstName} ${e.rider.lastName}` : "None";

    return {
      errandId: e.id,
      referenceCode: `#SGO-${e.id.slice(0, 8).toUpperCase()}`,
      category: e.category,
      status: e.status,
      dispatcher: dispatcherName,
      rider: riderName,
      route: `${e.pickupAddress} ➔ ${e.deliveryAddress}`,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  });

  return {
    activities,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}
