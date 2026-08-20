import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS token_blocklist (
      id INT AUTO_INCREMENT PRIMARY KEY,
      token VARCHAR(500) NOT NULL UNIQUE,
      expiresAt DATETIME NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_expiresAt (expiresAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log("✅ token_blocklist table verified/created successfully.");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Error creating table:", err);
  process.exit(1);
});
