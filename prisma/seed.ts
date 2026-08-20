import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed for User Management (Owners, Dispatchers, Riders)...');

  const DEFAULT_PASSWORD = 'Password123!';
  const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);

  // 1. OWNERS
  const owners = [
    {
      email: 'owner@speedyerrand.com',
      name: 'Juan Dela Cruz',
      phone: '+639171234567',
      role: Role.OWNER ?? 'OWNER',
    },
    {
      email: 'admin.ops@speedyerrand.com',
      name: 'Maria Santos',
      phone: '+639172345678',
      role: Role.OWNER ?? 'OWNER',
    },
  ];

  for (const owner of owners) {
    const user = await prisma.user.upsert({
      where: { email: owner.email },
      update: {
        name: owner.name,
        phone: owner.phone,
        role: owner.role,
      },
      create: {
        email: owner.email,
        name: owner.name,
        phone: owner.phone,
        password: hashedPassword,
        role: owner.role,
        status: 'ACTIVE',
      },
    });
    console.log(`✅ [OWNER] Seeded: ${user.name} (${user.email})`);
  }

  // 2. DISPATCHERS
  const dispatchers = [
    {
      email: 'dispatcher1@speedyerrand.com',
      name: 'Carlos Ramirez',
      phone: '+639183456789',
      role: Role.DISPATCHER ?? 'DISPATCHER',
    },
    {
      email: 'dispatcher2@speedyerrand.com',
      name: 'Elena Gomez',
      phone: '+639184567890',
      role: Role.DISPATCHER ?? 'DISPATCHER',
    },
    {
      email: 'tacurong.dispatch@speedyerrand.com',
      name: 'Mark Anthony Tan',
      phone: '+639185678901',
      role: Role.DISPATCHER ?? 'DISPATCHER',
    },
  ];

  for (const dispatcher of dispatchers) {
    const user = await prisma.user.upsert({
      where: { email: dispatcher.email },
      update: {
        name: dispatcher.name,
        phone: dispatcher.phone,
        role: dispatcher.role,
      },
      create: {
        email: dispatcher.email,
        name: dispatcher.name,
        phone: dispatcher.phone,
        password: hashedPassword,
        role: dispatcher.role,
        status: 'ACTIVE',
      },
    });
    console.log(`✅ [DISPATCHER] Seeded: ${user.name} (${user.email})`);
  }

  // 3. RIDERS (Strictly User table only)
  const riders = [
    {
      email: 'rider1@speedyerrand.com',
      name: 'Ricardo Dalisay',
      phone: '+639201112233',
      role: Role.RIDER ?? 'RIDER',
    },
    {
      email: 'rider2@speedyerrand.com',
      name: 'Eduardo Manalo',
      phone: '+639202223344',
      role: Role.RIDER ?? 'RIDER',
    },
    {
      email: 'rider3@speedyerrand.com',
      name: 'Angelo Reyes',
      phone: '+639203334455',
      role: Role.RIDER ?? 'RIDER',
    },
    {
      email: 'rider4@speedyerrand.com',
      name: 'Jerome Bautista',
      phone: '+639204445566',
      role: Role.RIDER ?? 'RIDER',
    },
  ];

  for (const rider of riders) {
    const user = await prisma.user.upsert({
      where: { email: rider.email },
      update: {
        name: rider.name,
        phone: rider.phone,
        role: rider.role,
      },
      create: {
        email: rider.email,
        name: rider.name,
        phone: rider.phone,
        password: hashedPassword,
        role: rider.role,
        status: 'ACTIVE',
      },
    });
    console.log(`✅ [RIDER] Seeded: ${user.name} (${user.email})`);
  }

  console.log('\n✨ Database seeding completed successfully!\n');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed with error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
