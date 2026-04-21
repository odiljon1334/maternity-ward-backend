/**
 * Bir martalik: userId=null bo'lib qolgan "yetim" direktor Employee larni o'chirish.
 * Eski direktor User o'chirilganda Employee yozuvi bazada qolib ketgan.
 *
 * Ishlatish:
 *   npx ts-node scripts/cleanup-orphan-directors.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Yetim direktor position lari (userId=null, position nomi 'Direktor')
  const orphans = await prisma.employee.findMany({
    where: {
      userId: null,
      position: { name: 'Direktor' },
    },
    include: { hospital: { select: { name: true } }, position: true },
  });

  if (orphans.length === 0) {
    console.log('✅ Yetim direktor yozuvlari topilmadi — baza toza.');
    return;
  }

  console.log(`⚠️  ${orphans.length} ta yetim direktor topildi:\n`);
  for (const emp of orphans) {
    console.log(`  - ${emp.fullName} | tel: ${emp.phone ?? '—'} | kasalxona: ${emp.hospital?.name ?? '—'}`);
  }

  const ids = orphans.map(e => e.id);
  const result = await prisma.employee.deleteMany({ where: { id: { in: ids } } });
  console.log(`\n✅ ${result.count} ta yetim yozuv o'chirildi.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
