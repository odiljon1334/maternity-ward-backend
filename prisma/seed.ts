import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...\n');

  // ─── 1. Super Admin (no hospital) ─────────────────────────
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
  console.log(`✅ Super Admin: ${superAdmin.username} / Admin@12345`);

  // ─── 2. Hospitals ─────────────────────────────────────────
  const hospitalData = [
    {
      name: "1-son Tug'ruq xona",
      code: 'TUG-01',
      address: 'Toshkent sh., Chilonzor tumani',
      phone: '+998711234501',
    },
    {
      name: "2-son Tug'ruq xona",
      code: 'TUG-02',
      address: 'Toshkent sh., Yunusobod tumani',
      phone: '+998711234502',
    },
    {
      name: "3-son Tug'ruq xona",
      code: 'TUG-03',
      address: 'Toshkent sh., Mirzo Ulugbek tumani',
      phone: '+998711234503',
    },
  ];

  const hospitals: Record<string, string> = {};
  for (const h of hospitalData) {
    const hosp = await prisma.hospital.upsert({
      where: { code: h.code },
      update: {},
      create: { ...h, isActive: true },
    });
    hospitals[h.code] = hosp.id;
    console.log(`✅ Hospital: ${h.name} (${h.code})`);
  }

  const demoId = hospitals['TUG-01'];

  // ─── 3. Departments for demo hospital (TUG-01) ────────────
  const departments = [
    {
      name: "Tug'ruq xona",
      code: 'MATERNITY',
      description: "Asosiy tug'ruq bo'limi",
    },
    {
      name: 'Reanimatsiya',
      code: 'ICU',
      description: "Intensiv davolash bo'limi",
    },
    {
      name: "Akusherlik bo'limi",
      code: 'OBSTETRICS',
      description: 'Akusherlik va ginekologiya',
    },
    {
      name: "Yangi tug'ilganlar",
      code: 'NEONATAL',
      description: "Chaqaloqlar bo'limi",
    },
    { name: "Ma'muriyat", code: 'ADMIN', description: "Ma'muriy xodimlar" },
  ];

  const deptIds: Record<string, string> = {};
  for (const dept of departments) {
    const d = await prisma.department.upsert({
      where: { hospitalId_code: { hospitalId: demoId, code: dept.code } },
      update: {},
      create: { ...dept, hospitalId: demoId },
    });
    deptIds[dept.code] = d.id;
    console.log(`✅ Department: ${dept.name}`);
  }

  // ─── 4. Positions for demo hospital (TUG-01) ──────────────
  const positionNames = [
    'Direktor',
    'Bosh vrach',
    'Vrach-akusher',
    'Vrach-ginekolog',
    'Vrach-neonatolog',
    'Bosh hamshira',
    'Hamshira',
    'Akusherka',
    'Laborant',
    'Registrator',
    "Xo'jalik bo'limi",
    'Qorovul',
  ];

  const posIds: Record<string, string> = {};
  for (const name of positionNames) {
    const p = await prisma.position.upsert({
      where: { hospitalId_name: { hospitalId: demoId, name } },
      update: {},
      create: { name, hospitalId: demoId },
    });
    posIds[name] = p.id;
    console.log(`✅ Position: ${name}`);
  }

  // ─── 5. Shift Templates for demo hospital (TUG-01) ────────
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
      where: { hospitalId_name: { hospitalId: demoId, name: shift.name } },
      update: shift,
      create: { ...shift, hospitalId: demoId },
    });
    console.log(
      `✅ Shift: ${shift.name} (${shift.startTime}–${shift.endTime})`,
    );
  }

  // ─── 6. System Settings (global) ──────────────────────────
  const settings = [
    { key: 'late_grace_minutes', value: '15' },
    { key: 'weekly_late_threshold_min', value: '120' },
    { key: 'overtime_rate', value: '1.5' },
  ];

  for (const s of settings) {
    const existing = await prisma.systemSettings.findFirst({
      where: { key: s.key, hospitalId: null },
    });
    if (existing) {
      await prisma.systemSettings.update({
        where: { id: existing.id },
        data: { value: s.value },
      });
    } else {
      await prisma.systemSettings.create({
        data: { key: s.key, value: s.value, hospitalId: null },
      });
    }
  }
  console.log('✅ System settings configured');

  // ─── 7. Demo Director for TUG-01 ──────────────────────────
  const dirHash = await bcrypt.hash('Director@123', 10);
  const dirUser = await prisma.user.upsert({
    where: { username: 'director1' },
    update: {},
    create: {
      username: 'director1',
      passwordHash: dirHash,
      role: 'DIRECTOR',
      status: 'ACTIVE',
      hospitalId: demoId,
    },
  });

  await prisma.employee.upsert({
    where: { userId: dirUser.id },
    update: {},
    create: {
      fullName: 'Aziz Karimov',
      gender: 'MALE',
      phone: '+998901234567',
      departmentId: deptIds['ADMIN'],
      positionId: posIds['Direktor'],
      baseSalary: 5_000_000,
      hospitalId: demoId,
      userId: dirUser.id,
    },
  });
  console.log(`✅ Demo Director: director1 / Director@123 (TUG-01)`);

  console.log('\n✅ Seeding completed!\n');
  console.log('🔑 Login credentials:');
  console.log('   superadmin / Admin@12345  (SUPER_ADMIN — no hospital)');
  console.log("   director1  / Director@123 (DIRECTOR — 1-son Tug'ruq xona)\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
