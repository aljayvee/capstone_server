import { PrismaClient, RoleType } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database with core accounts...");

  // 2. User Accounts (Owner only)
  const hashedOwnerPass = await bcrypt.hash("owner123", 10);

  const owner = await prisma.user.upsert({
    where: { username: "owner" },
    update: { passwordHash: hashedOwnerPass },
    create: {
      username: "owner",
      passwordHash: hashedOwnerPass,
      role: RoleType.OWNER,
      firstName: "Aljayvee",
      middleName: "P.",
      lastName: "Versola",
      email: "aj.versola@company.ph",
      phone: "09171234567",
      avatar: "AV",
      status: "Active",
    },
  });

  // 3. Rate Config — deliberately NOT seeded.
  //
  // Rates are the owner's to set, and there is no such thing as a default one.
  // A seeded row is indistinguishable from a configured row the moment it
  // exists: the portal shows it, the pricing strategy charges it, and nobody
  // downstream can tell the customer is being billed a figure that was never
  // chosen. Seeding "a sensible starting rate" is the same bug as a column
  // default, one layer up.
  //
  // Until the owner saves their rates in the Service Rates module, no config
  // row exists, and the read paths already handle that honestly rather than
  // falling back: quoteErrand refuses with a 503 ("Pricing is not configured
  // yet") and recalculateFee leaves the errand's fee untouched.

  // 4. Payment Modes — only Cash on Delivery is functional today. The other
  // three are seeded as `Inactive` (repurposing the existing Active/Inactive
  // convention rather than adding a new field) so both the UI badge and a real
  // server-side check in paymentSelectionService.ts agree on what's selectable.
  // Flipping one to Active later (once its gateway integration exists) is then
  // a data change, not a code change.
  const paymentModes: Array<{ name: string; status: "Active" | "Inactive" }> = [
    { name: "Cash on Delivery", status: "Active" },
    { name: "GCash / PayMaya", status: "Inactive" },
    { name: "Bank Transfer", status: "Inactive" },
    { name: "Debit/Credit Card", status: "Inactive" },
  ];
  for (const mode of paymentModes) {
    await prisma.paymentMode.upsert({
      where: { name: mode.name },
      update: { status: mode.status },
      create: mode,
    });
  }

  console.log("✅ Database Seeding Completed Successfully!");
  console.log(`- Owner: ${owner.firstName} ${owner.lastName} (${owner.username})`);
  console.log(`- Payment modes seeded: ${paymentModes.map((m) => `${m.name} (${m.status})`).join(", ")}`);
}

main()
  .catch((e) => {
    console.error("❌ Seed Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
