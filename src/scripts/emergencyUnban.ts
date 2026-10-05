/**
 * emergencyUnban.ts
 *
 * Emergency CLI tool to immediately revoke an IP ban via SSH console:
 *   npm run security:unban <ip_address>
 */

import { prisma } from "../lib/prisma.js";
import { sysAdminThreatService } from "../services/sysAdminThreatService.js";

async function main() {
  const targetIp = process.argv[2]?.trim();

  if (!targetIp) {
    console.error("❌ Error: Missing IP address argument.");
    console.error("Usage: npm run security:unban <ip_address>");
    process.exit(1);
  }

  const normalizedIp = targetIp.replace(/^::ffff:/, "");
  console.log(`[EmergencyUnban] Searching active ban for IP: ${normalizedIp}...`);

  const banRecord = await prisma.blockedIp.findFirst({
    where: { ipAddress: normalizedIp, status: "ACTIVE" },
  });

  if (!banRecord) {
    console.log(`⚠️ No active ban found for IP ${normalizedIp}.`);
    process.exit(0);
  }

  await sysAdminThreatService.unblockIp(banRecord.id, undefined, "Emergency CLI unban");

  console.log(`✅ SUCCESS: IP ${normalizedIp} has been unbanned.`);
  console.log(`   Reason previously: "${banRecord.reason}"`);
  console.log(`   Nginx blocklist refreshed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Fatal unban error:", err);
  process.exit(1);
});
