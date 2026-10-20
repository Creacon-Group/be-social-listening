/**
 * Seed: one project, five brands with keyword aliases, and an admin user.
 * Aliases were built from the 141 distinct Keyword values in the September 2026 Zanroo export.
 * Usage: SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... npm run db:seed
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import bcrypt from 'bcryptjs';
import { mysqlConfigFromUrl } from '../src/database/mysql-config.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

// Keywords shared by two brands are counted for both (confirmed definition of SOV).
const SHARED_IOH = [
  'Indosat Ooredoo Hutchison',
  '#IndosatOoredooHutchison',
  'Merger Tri - Indosat',
  '#LebihHematSinyalLancar',
  '#JadiLebihHebat',
  '#KuotaHappy',
  '#BersamaBikinSeru',
  '#TechMate',
  '#3Techmate',
];
const SHARED_XLSMART = ['xlsmart', '#XLSmart', 'XLSMART'];

const BRANDS: {
  name: string;
  isOwn: boolean;
  color: string;
  aliases: string[];
}[] = [
  {
    name: 'Indosat',
    isOwn: true,
    color: '#E11D48',
    aliases: [
      'IM3',
      'IM3 Ooredoo',
      'Indosat Ooredoo Care',
      'Activation Indosat',
      'Indosat - Freedom Internet',
      'Indosat- Freedom U',
      'InternetFreedom',
      '#IM3Platinum',
      '#SahabatBaikku',
      ...SHARED_IOH,
    ],
  },
  {
    name: 'Tri',
    isOwn: true,
    color: '#7C3AED',
    aliases: [
      'TRI',
      'TRI ID',
      '3 Indonesia',
      '3Care Indonesia',
      'Tri Indonesia',
      'Activation Tri',
      'bima+',
      '#CosplayCompetition',
      '#H3RO',
      'H3RO - PushRankTanpaHenti (h3ro.tri.co.id)',
      '#H3ROAmongTheHeroes',
      '#H3ROCOMICCON',
      '#PushRankTanpaHenti',
      '#BombasTri',
      '#BonsTri',
      '#HoYoFest2026',
      '#TriLebihHematSinyalCepat',
      '3DigiBox',
      ...SHARED_IOH,
    ],
  },
  {
    name: 'Telkomsel',
    isOwn: false,
    color: '#8B95A7',
    aliases: [
      'Activation Telkomsel',
      'by.U',
      'by.U Indonesia',
      'Kartu As',
      'simPATI',
      'kartuHALO',
      'Kartu Halo',
      'Telkomsel Halo',
      '#myTelkomsel',
      'TelkomselPOIN',
      '#Poinhepi',
      'TSEL- Unlimited Internetan',
      'TSEL- Surprise Deal',
      'TSEL- Combo Sakti',
      'TSEL-Paket Darurat',
      'TSEL- Kuota Keluarga',
      'MAXstream.tv',
      'GamesMAX',
      'Dunia Games',
      'DuniaGamesHunt',
    ],
  },
  {
    name: 'XL',
    isOwn: false,
    color: '#6C8EBF',
    aliases: [
      'XL Axiata',
      'Axis',
      'Activation XL',
      'myXL',
      'myXLCare',
      'XL Prabayar',
      'XL Prioritas',
      'XL #WeAreMore',
      'XL - Paket Akrab',
      'XL - Xtra Combo',
      'Axis - #EmangKitaBeda',
      'Axis - Paket BROnet',
      'Axis - Paket Warnet',
      '#FutsalAxisNationCup',
      '#BersamaMelajuTanpaBatas',
      '#GiveawayXLSATU',
      '#QuizSeruMaya',
      '#SuaraParaJuara',
      ...SHARED_XLSMART,
    ],
  },
  {
    name: 'Smartfren',
    isOwn: false,
    color: '#C9A35B',
    aliases: [
      'Smartfrencare',
      'Smartfren 4G',
      'Smartfren- Paket Unlimited',
      'Smartfren- Kuota NONSTOP',
      'Smartfren- Super 4G Kuota',
      'Activation Smartfren',
      '#JagoanSinyalSeIndonesia',
      '#100PersenIndonesia',
      ...SHARED_XLSMART,
    ],
  },
];

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb(
      mysqlConfigFromUrl(process.env.DATABASE_URL ?? ''),
    ),
  });

  const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || password.length < 10) {
    throw new Error(
      'Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (min 10 characters)',
    );
  }

  const project = await prisma.project.upsert({
    where: { slug: 'ioh-social-listening' },
    update: {},
    create: {
      name: 'IOH Social Listening',
      slug: 'ioh-social-listening',
      description: 'Indosat + Tri vs kompetitor',
    },
  });

  for (const b of BRANDS) {
    await prisma.brand.upsert({
      where: { projectId_name: { projectId: project.id, name: b.name } },
      update: { isOwn: b.isOwn, color: b.color, aliases: b.aliases },
      create: {
        projectId: project.id,
        name: b.name,
        isOwn: b.isOwn,
        color: b.color,
        aliases: b.aliases,
      },
    });
  }

  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: 'Admin',
      role: 'ADMIN',
      passwordHash: await bcrypt.hash(password, 12),
    },
  });
  await prisma.projectMember.upsert({
    where: { userId_projectId: { userId: admin.id, projectId: project.id } },
    update: {},
    create: { userId: admin.id, projectId: project.id },
  });

  console.log(
    `Seeded project #${project.id} (${BRANDS.length} brands) and admin ${email}`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
