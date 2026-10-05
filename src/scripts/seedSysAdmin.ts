import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { sysAdminPasswordPolicy } from "../validators/sysAdminValidators.js";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding System Administrator IT account...");

  const username = "sysadminit";
  // From the environment, never from this file: the password that used to be
  // written here was committed to a public repository. Run as
  //   SYSADMIN_SEED_PASSWORD='...' npm run seed:sysadmin
  const passwordCheck = sysAdminPasswordPolicy.safeParse(process.env.SYSADMIN_SEED_PASSWORD ?? "");
  if (!passwordCheck.success) {
    throw new Error(
      `Set SYSADMIN_SEED_PASSWORD to seed the sysadmin account. ${passwordCheck.error.issues[0]?.message ?? ""}`
    );
  }
  const rawPassword = passwordCheck.data;
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
