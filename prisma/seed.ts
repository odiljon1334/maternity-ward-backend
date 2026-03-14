import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...\n');

  // ─── 1. Super Admin ───────────────────────────────────────
  const adminHash = await bcrypt.hash('Admin@12345', 10);
  const superAdmin = await prisma.user.upsert({
    where: { username: 'superadmin' },
    update: {},
    create: {
      username: 'superadmin',
      passwordHash: adminHash,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
    },
  });
  console.log(`✅ Super Admin: ${superAdmin.username}`);

  // ─── 2. Default Departments ───────────────────────────────
  const departments = [
    { name: 'Tug\'ruq xona', code: 'MATERNITY', description: 'Asosiy tug\'ruq bo\'limi' },
    { name: 'Reanimatsiya', code: 'ICU', description: 'Intensiv davolash bo\'limi' },
    { name: 'Akusherlik bo\'limi', code: 'OBSTETRICS', description: 'Akusherlik va ginekologiya' },
    { name: 'Yangi tug\'ilganlar', code: 'NEONATAL', description: 'Chaqaloqlar bo\'limi' },
    { name: 'Ma\'muriyat', code: 'ADMIN', description: 'Ma\'muriy xodimlar' },
  ];

  for (const dept of departments) {
    await prisma.department.upsert({
      where: { code: dept.code },
      update: {},
      create: dept,
    });
    console.log(`✅ Department: ${dept.name}`);
  }

  // ─── 3. Default Positions ─────────────────────────────────
  const positions = [
    'Direktor', 'Bosh vrach', 'Vrach-akusher', 'Vrach-ginekolog',
    'Vrach-neonatolog', 'Bosh hamshira', 'Hamshira', 'Akusherka',
    'Laborant', 'Registrator', 'Xo\'jalik bo\'limi', 'Qorovul',
  ];

  for (const name of positions) {
    await prisma.position.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    console.log(`✅ Position: ${name}`);
  }

  // ─── 4. Shift Templates ───────────────────────────────────
  const shifts = [
    {
      name: 'Kunduzgi smen',
      type: 'DAYTIME' as const,
      startTime: '08:00',
      endTime: '20:00',
      isOvernight: false,
      durationH: 12,
      graceMinutes: 15,
    },
    {
      name: 'Kechki smen',
      type: 'NIGHTTIME' as const,
      startTime: '20:00',
      endTime: '08:00',
      isOvernight: true,
      durationH: 12,
      graceMinutes: 15,
    },
  ];

  for (const shift of shifts) {
    await prisma.shiftTemplate.upsert({
      where: { name: shift.name },
      update: shift,
      create: shift,
    });
    console.log(`✅ Shift: ${shift.name} (${shift.startTime}–${shift.endTime})`);
  }

  // ─── 5. System Settings ──────────────────────────────────
  const settings = [
    { key: 'late_grace_minutes', value: '15' },
    { key: 'weekly_late_threshold_min', value: '120' },
    { key: 'overtime_rate', value: '1.5' },
    { key: 'hospital_name', value: 'Tug\'ruq xona' },
    { key: 'hospital_city', value: 'Toshkent' },
  ];

  for (const s of settings) {
    await prisma.systemSettings.upsert({
      where: { key: s.key },
      update: { value: s.value },
      create: s,
    });
  }
  console.log(`✅ System settings configured`);

  // ─── 6. Demo Director ────────────────────────────────────
  const deptMaternity = await prisma.department.findUnique({ where: { code: 'MATERNITY' } });
  const posDirector = await prisma.position.findUnique({ where: { name: 'Direktor' } });

  if (deptMaternity && posDirector) {
    const dirHash = await bcrypt.hash('Director@123', 10);
    const dirUser = await prisma.user.upsert({
      where: { username: 'director' },
      update: {},
      create: {
        username: 'director',
        passwordHash: dirHash,
        role: 'DIRECTOR',
        status: 'ACTIVE',
      },
    });

    await prisma.employee.upsert({
      where: { employeeNo: 'EMP001' },
      update: {},
      create: {
        employeeNo: 'EMP001',
        fullName: 'Aziz Karimov',
        gender: 'MALE',
        phone: '+998901234567',
        departmentId: deptMaternity.id,
        positionId: posDirector.id,
        baseSalary: 5_000_000,
        userId: dirUser.id,
      },
    });
    console.log(`✅ Demo Director: ${dirUser.username} / Director@123`);
  }

  console.log('\n✅ Seeding completed!\n');
  console.log('🔑 Login credentials:');
  console.log('   superadmin / Admin@12345  (SUPER_ADMIN)');
  console.log('   director   / Director@123 (DIRECTOR)\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
