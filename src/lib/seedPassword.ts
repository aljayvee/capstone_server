// Seed passwords come from the environment, never from source. The repository
// is public, and a seeded password nobody chose is a password anyone can read:
// the seeders used to hard-code one per role, and the accounts they made are
// Active and verified, so they skip the sign-in OTP (Codex security scan,
// 2026-11-02). Same idea as SYSADMIN_SEED_PASSWORD in scripts/seedSysAdmin.ts.
//
//   OWNER_SEED_PASSWORD='...' npm run seed:users
const MIN_LENGTH = 12;

export function seedPassword(name: string): string {
  const value = process.env[name] ?? "";
  if (value.length < MIN_LENGTH) {
    throw new Error(`Set ${name} (at least ${MIN_LENGTH} characters) to seed these accounts.`);
  }
  return value;
}
