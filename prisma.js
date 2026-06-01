require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
let prisma = null;

async function getPrisma() {
  if (prisma) return prisma;
  try {
    const adapter = new PrismaPg(pgPool);
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();
    console.log('✅ Prisma connected to PostgreSQL');
  } catch (e) {
    console.warn('⚠️  Prisma unavailable:', e.message);
    prisma = null;
  }
  return prisma;
}

getPrisma().catch(() => {});

module.exports = { getPrisma };
