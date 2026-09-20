import { prisma } from "../lib/prisma.js";
import { ServiceError } from "./ServiceError.js";
import * as sessionService from "./sessionService.js";
import * as userPresenceStore from "../lib/userPresenceStore.js";
import * as riderPresenceStore from "../lib/riderPresenceStore.js";
import { notifySessionRevoked } from "../lib/socket.js";
import type { RoleType } from "@prisma/client";

export interface MonitoredAccount {
  id: number;
  username: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  name: string;
  email: string;
  phone: string;
  role: "OWNER" | "DISPATCHER" | "RIDER" | "CUSTOMER";
  status: string;
  isOnline: boolean;
  activeSessionsCount: number;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListAccountsFilters {
  role?: string; // "ALL" | "OWNER" | "DISPATCHER" | "RIDER" | "CUSTOMER"
  search?: string;
  status?: string; // "ALL" | "Active" | "Suspended" | "Inactive" | "Locked"
  page?: number;
  limit?: number;
}

export async function listMonitoredAccounts(filters: ListAccountsFilters = {}) {
  const targetRole = filters.role ? filters.role.toUpperCase() : "ALL";
  const search = filters.search?.trim().toLowerCase() || "";
  const status = filters.status && filters.status !== "ALL" ? filters.status : undefined;

  const now = new Date();
  const accounts: MonitoredAccount[] = [];

  // 1. Fetch Staff Accounts (OWNER, DISPATCHER, RIDER) if requested
  const shouldFetchStaff = targetRole === "ALL" || ["OWNER", "DISPATCHER", "RIDER"].includes(targetRole);

  if (shouldFetchStaff) {
    const staffWhere: any = {};
    if (targetRole !== "ALL") {
      staffWhere.role = targetRole as RoleType;
    }
    if (status) {
      staffWhere.status = status;
    }
    if (search) {
      staffWhere.OR = [
        { username: { contains: search } },
        { firstName: { contains: search } },
        { lastName: { contains: search } },
        { email: { contains: search } },
        { phone: { contains: search } },
      ];
    }

    const staffUsers = await prisma.user.findMany({
      where: staffWhere,
      select: {
        id: true,
        username: true,
        firstName: true,
        middleName: true,
        lastName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Session counts for staff
    const staffIds = staffUsers.map((u) => u.id);
    const staffSessions = await prisma.userSession.groupBy({
      by: ["subjectId"],
      where: {
        subjectId: { in: staffIds },
        subjectType: "USER",
        revokedAt: null,
        expiresAt: { gt: now },
      },
      _count: { id: true },
    });
    const sessionCountMap = new Map<number, number>(
      staffSessions.map((s) => [s.subjectId, s._count.id])
    );

    for (const u of staffUsers) {
      const isUserOnline =
        u.role === "RIDER"
          ? riderPresenceStore.isOnline(u.id) || userPresenceStore.isOnline(u.id)
          : userPresenceStore.isOnline(u.id);

      accounts.push({
        id: u.id,
        username: u.username,
        firstName: u.firstName,
        middleName: u.middleName,
        lastName: u.lastName,
        name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.username,
        email: u.email,
        phone: u.phone,
        role: u.role as "OWNER" | "DISPATCHER" | "RIDER",
        status: u.status,
        isOnline: isUserOnline,
        activeSessionsCount: sessionCountMap.get(u.id) || 0,
        emailVerified: u.emailVerified,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      });
    }
  }

  // 2. Fetch Customer Accounts if requested
  const shouldFetchCustomers = targetRole === "ALL" || targetRole === "CUSTOMER";

  if (shouldFetchCustomers) {
    const customerWhere: any = {};
    if (status) {
      customerWhere.status = status;
    }
    if (search) {
      customerWhere.OR = [
        { username: { contains: search } },
        { email: { contains: search } },
        {
          information: {
            OR: [
              { firstName: { contains: search } },
              { lastName: { contains: search } },
              { phone: { contains: search } },
            ],
          },
        },
      ];
    }

    const customers = await prisma.customerAccount.findMany({
      where: customerWhere,
      select: {
        id: true,
        username: true,
        email: true,
        status: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
        information: {
          select: {
            firstName: true,
            middleName: true,
            lastName: true,
            phone: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const customerIds = customers.map((c) => c.id);
    const customerSessions = await prisma.userSession.groupBy({
      by: ["subjectId"],
      where: {
        subjectId: { in: customerIds },
        subjectType: "CUSTOMER",
        revokedAt: null,
        expiresAt: { gt: now },
      },
      _count: { id: true },
    });
    const customerSessionCountMap = new Map<number, number>(
      customerSessions.map((s) => [s.subjectId, s._count.id])
    );

    for (const c of customers) {
      const fName = c.information?.firstName || "";
      const lName = c.information?.lastName || "";
      const activeCount = customerSessionCountMap.get(c.id) || 0;

      accounts.push({
        id: c.id,
        username: c.username,
        firstName: fName,
        middleName: c.information?.middleName || null,
        lastName: lName,
        name: [fName, lName].filter(Boolean).join(" ").trim() || c.username,
        email: c.email,
        phone: c.information?.phone || "N/A",
        role: "CUSTOMER",
        status: c.status,
        isOnline: activeCount > 0, // Customer presence inferred from active sessions
        activeSessionsCount: activeCount,
        emailVerified: c.emailVerified,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      });
    }
  }

  // Sort by recent created or active
  accounts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const page = Math.max(1, filters.page || 1);
  const limit = Math.max(1, Math.min(filters.limit || 50, 200));
  const total = accounts.length;
  const paginated = accounts.slice((page - 1) * limit, page * limit);

  return {
    accounts: paginated,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    counts: {
      all: accounts.length,
      owners: accounts.filter((a) => a.role === "OWNER").length,
      dispatchers: accounts.filter((a) => a.role === "DISPATCHER").length,
      riders: accounts.filter((a) => a.role === "RIDER").length,
      customers: accounts.filter((a) => a.role === "CUSTOMER").length,
      onlineTotal: accounts.filter((a) => a.isOnline).length,
    },
  };
}

export async function getAccountSessions(role: string, accountId: number) {
  const normRole = role.toUpperCase();
  const subjectType: sessionService.SubjectType = normRole === "CUSTOMER" ? "CUSTOMER" : "USER";

  const sessions = await prisma.userSession.findMany({
    where: {
      subjectId: accountId,
      subjectType,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      deviceId: true,
      userAgent: true,
      ipAddress: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      role: true,
    },
    orderBy: { lastUsedAt: "desc" },
  });

  return sessions;
}

export async function terminateAccountSession(sessionId: string, adminNickname: string) {
  const session = await prisma.userSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new ServiceError(404, "Session not found.");
  }

  await sessionService.revokeSession(sessionId, "TERMINATED_BY_SYSADMIN");

  if (session.subjectType === "USER") {
    notifySessionRevoked(session.subjectId, {
      reason: `Session was terminated remotely by System Administrator (@${adminNickname}).`,
    });
  }

  // Audit trail
  await prisma.accountModificationLog.create({
    data: {
      role: session.role,
      userId: session.subjectType === "USER" ? session.subjectId : null,
      customerId: session.subjectType === "CUSTOMER" ? session.subjectId : null,
      fieldModified: "session_eviction",
      oldValue: `session:${sessionId}`,
      newValue: "REVOKED",
      verifiedVia: "SYSADMIN_ACTION",
    },
  });

  return { message: "Session terminated successfully." };
}

export async function updateAccountStatus(
  role: string,
  accountId: number,
  newStatus: string,
  adminNickname: string,
  reason?: string
) {
  const normRole = role.toUpperCase();
  const validStatuses = ["Active", "Suspended", "Inactive", "Locked"];

  if (!validStatuses.includes(newStatus)) {
    throw new ServiceError(400, `Invalid status. Must be one of: ${validStatuses.join(", ")}`);
  }

  let oldStatus = "Unknown";

  if (normRole === "CUSTOMER") {
    const customer = await prisma.customerAccount.findUnique({ where: { id: accountId } });
    if (!customer) throw new ServiceError(404, "Customer account not found.");
    oldStatus = customer.status;

    await prisma.customerAccount.update({
      where: { id: accountId },
      data: { status: newStatus },
    });

    if (newStatus === "Suspended" || newStatus === "Locked") {
      await sessionService.revokeAllSubjectSessions(accountId, "CUSTOMER", `ACCOUNT_${newStatus.toUpperCase()}_BY_SYSADMIN`);
    }
  } else {
    const user = await prisma.user.findUnique({ where: { id: accountId } });
    if (!user) throw new ServiceError(404, "Operational staff account not found.");
    oldStatus = user.status;

    await prisma.user.update({
      where: { id: accountId },
      data: { status: newStatus },
    });

    if (newStatus === "Suspended" || newStatus === "Locked") {
      await sessionService.revokeAllSubjectSessions(accountId, "USER", `ACCOUNT_${newStatus.toUpperCase()}_BY_SYSADMIN`);
      notifySessionRevoked(accountId, {
        reason: `Your account was ${newStatus.toLowerCase()} by System Administrator (@${adminNickname}): ${reason || "Security policy review"}.`,
      });
    }
  }

  // Record audit log
  await prisma.accountModificationLog.create({
    data: {
      role: normRole,
      userId: normRole !== "CUSTOMER" ? accountId : null,
      customerId: normRole === "CUSTOMER" ? accountId : null,
      fieldModified: "account_status",
      oldValue: oldStatus,
      newValue: newStatus,
      verifiedVia: `SYSADMIN_STATUS_UPDATE:${adminNickname}`,
    },
  });

  return {
    message: `Account status updated from ${oldStatus} to ${newStatus}.`,
    id: accountId,
    role: normRole,
    status: newStatus,
  };
}
