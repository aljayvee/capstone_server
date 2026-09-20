import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding System Administrator IT account...");

  const username = "sysadminit";
  const rawPassword = "Astrowarden@12";
  const passwordHash = await bcrypt.hash(rawPassword, 10);

  const admin = await prisma.sysAdmin.upsert({
    where: { username },
    update: {
      passwordHash,
      status: "Active",
      role: "SYSADMIN",
    },
    create: {
      username,
      passwordHash,
      role: "SYSADMIN",
      status: "Active",
      profileCompleted: false,
      emailVerified: false,
    },
  });

  console.log(`✅ System Administrator root account ready:`);
  console.log(`   ID: ${admin.id}`);
  console.log(`   Username: ${admin.username}`);
  console.log(`   Role: ${admin.role}`);
  console.log(`   Profile Completed: ${admin.profileCompleted ? "YES" : "NO (Setup wizard will trigger on first login)"}`);
  console.log(`   Email Verified: ${admin.emailVerified ? "YES" : "NO"}`);
}

main()
  .catch((e) => {
    console.error("❌ Failed to seed sysadmin account:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
