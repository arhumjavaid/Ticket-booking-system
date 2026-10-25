/**
 * Bulk-insert synthetic users for scale demos (default 1_000_000).
 *
 * Usage:
 *   SEED_USER_COUNT=1000000 npm run seed:scale --workspace=@ticketing/database
 *   SEED_USER_COUNT=2000000 docker compose run --rm --entrypoint \
 *     sh migrate -c 'npx ts-node prisma/seedScale.ts'
 *
 * Shared password for every scale user: Password123!
 * Emails: scale-user-{n}@ticketing.dev
 *
 * Does NOT replace the normal seed (admin + user1..5 + venues/events).
 * Run `npm run seed` first if the catalogue is empty.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const TARGET = Math.max(0, parseInt(process.env.SEED_USER_COUNT || '1000000', 10));
const BATCH = Math.max(100, Math.min(parseInt(process.env.SEED_USER_BATCH || '10000', 10), 50000));
const PASSWORD = 'Password123!';

async function main() {
  if (TARGET === 0) {
    console.log('SEED_USER_COUNT=0 — nothing to do.');
    return;
  }

  console.log(`Scale seed: targeting ${TARGET.toLocaleString()} synthetic users (batch ${BATCH})...`);

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const existing = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM users WHERE email LIKE 'scale-user-%@ticketing.dev'
  `;
  let have = Number(existing[0]?.count ?? 0);
  console.log(`Already have ${have.toLocaleString()} scale users.`);

  if (have >= TARGET) {
    console.log('Target already met. Skipping inserts.');
  } else {
    const started = Date.now();
    while (have < TARGET) {
      const start = have + 1;
      const end = Math.min(have + BATCH, TARGET);
      // generate_series + ON CONFLICT keeps re-runs cheap and avoids ORM overhead.
      await prisma.$executeRaw`
        INSERT INTO users (id, email, password_hash, name, role, created_at, updated_at)
        SELECT gen_random_uuid(),
               'scale-user-' || g || '@ticketing.dev',
               ${passwordHash},
               'Scale User ' || g,
               'USER',
               NOW(),
               NOW()
        FROM generate_series(${start}, ${end}) AS g
        ON CONFLICT (email) DO NOTHING
      `;
      have = end;
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`  … ${have.toLocaleString()} / ${TARGET.toLocaleString()} (${elapsed}s)`);
    }
    console.log(`Inserted up to ${TARGET.toLocaleString()} scale users in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  }

  const total = await prisma.user.count();
  console.log(`Total users in DB: ${total.toLocaleString()}`);
  console.log(`Scale login example: scale-user-1@ticketing.dev / ${PASSWORD}`);
  console.log('Restart the worker (or wait for bloom rebuild) so the username Bloom filter includes the new emails.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
