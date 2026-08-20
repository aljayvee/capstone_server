/**
 * Password Migration Script
 *
 * Finds all users whose `passwordHash` is stored as plain text
 * (i.e., not a valid bcrypt hash starting with $2a$ or $2b$)
 * and re-hashes them using bcrypt with 10 salt rounds.
 *
 * Run once after the bcrypt login endpoint is added to fix existing users.
 * Usage: npx tsx src/migrate-passwords.ts
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

/** Returns true if the string is already a valid bcrypt hash */
function isBcryptHash(value: string): boolean {
  return /^\$2[ab]\$\d{2}\$/.test(value);
}

async function migratePasswords() {
  console.log(" Starting password migration...");

  const users = await prisma.user.findMany({
    select: { id: true, username: true, passwordHash: true },
  });

  console.log(`Found ${users.length} user(s) in the database.`);

  let migrated = 0;
  let skipped = 0;

  for (const user of users) {
    if (isBcryptHash(user.passwordHash)) {
      console.log(` [${user.username}] already has a bcrypt hash — skipping.`);
      skipped++;
      continue;
    }

    // The stored value is plain text — re-hash it
    const newHash = await bcrypt.hash(user.passwordHash, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    console.log(` [${user.username}] plain-text password migrated to bcrypt hash.`);
    migrated++;
  }

  console.log(`\nMigration complete! Migrated: ${migrated}, Already hashed: ${skipped}`);
}

migratePasswords()
  .catch((e) => {
    console.error(" Migration failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
