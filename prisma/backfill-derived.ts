/**
 * Fills the derived mention columns (isOwned, isPaid, tierRank, gender, province, country,
 * bookmarks, reactions) for existing rows, in id batches so TiDB never sees one huge
 * transaction. Safe to run again. Run after `npm run db:deploy`:
 *   npm run db:backfill-derived            all rows
 *   npm run db:backfill-derived -- 123456  only rows with id > 123456 (catch-up after deploy)
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { mysqlConfigFromUrl } from '../src/database/mysql-config.js';
import { derivedSet } from '../src/modules/mentions/mention-sql.js';

const BATCH = 2000;
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const prisma = new PrismaClient({ adapter: new PrismaMariaDb(mysqlConfigFromUrl(url)) });

const after = Number(process.argv[2] ?? 0);
const [{ lo, hi }] = await prisma.$queryRaw<{ lo: number | null; hi: number | null }[]>`
  SELECT MIN(id) AS lo, MAX(id) AS hi FROM mentions WHERE id > ${after}`;
if (lo == null || hi == null) {
  console.log('Nothing to backfill.');
} else {
  const started = Date.now();
  let rows = 0;
  for (let from = Number(lo); from <= Number(hi); from += BATCH) {
    rows += await prisma.$executeRaw`
      UPDATE mentions m SET ${derivedSet()} WHERE m.id >= ${from} AND m.id < ${from + BATCH}`;
    process.stdout.write(`\rids ${lo}..${Math.min(from + BATCH - 1, Number(hi))} of ${hi}`);
  }
  console.log(`\nDone: ${rows} rows touched in ${Math.round((Date.now() - started) / 1000)} s. Highest id: ${hi}`);
}
await prisma.$disconnect();
