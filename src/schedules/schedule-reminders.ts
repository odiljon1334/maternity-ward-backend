import { MonthlySchedulePlanStatus, ScheduleStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';
import {
  LEAVE_NOTE_PREFIX,
  LEAVE_WRITTEN_STATUSES,
} from '../leave/leave.service';

/**
 * Keyingi oy grafigi kiritilmagan xodimlar/postlar haqida ogohlantirish.
 *
 * Grafik endi avtomatik ko'chirilmaydi: har oy yangi grafik kiritiladi,
 * kiritilmasa xodim "Grafik yo'q" holatida qoladi. Shuning uchun oy
 * tugashidan 3 va 2 kun oldin kadr inspektori (ADMIN) va direktorga
 * kimning grafigi yo'qligi aytiladi.
 */

export const UZ_MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
];

/** Oy tugashidan necha kun oldin ogohlantiriladi */
export const REMINDER_DAYS_BEFORE = [3, 2];

export type MissingScheduleSummary = {
  hospitalId: string;
  hospitalName: string;
  /** Oddiy grafik: grafigi yo'q faol xodimlar, bo'limlar kesimida */
  employees: { total: number; byDepartment: Array<[string, number]> };
  /** Post reja: keyingi oy rejasi tasdiqlanmagan postlar */
  posts: Array<{ name: string; state: string }>;
};

const PLAN_STATE: Record<string, string> = {
  NONE: 'yaratilmagan',
  [MonthlySchedulePlanStatus.DRAFT]: 'qoralama',
  [MonthlySchedulePlanStatus.SUBMITTED]: 'tasdiq kutmoqda',
  [MonthlySchedulePlanStatus.REJECTED]: 'rad etilgan',
};

/** Bugundan keyingi oy boshigacha necha kun qolgani (oyning oxirgi kuni — 1) */
export function daysUntilNextMonth(now: Date = new Date()): number {
  const today = DateUtil.toTz(now);
  return today.daysInMonth() - today.date() + 1;
}

const isLeaveRow = (row: { status: ScheduleStatus; note: string | null }) =>
  LEAVE_WRITTEN_STATUSES.includes(row.status) &&
  (row.note ?? '').startsWith(LEAVE_NOTE_PREFIX);

export async function collectMissingSchedules(
  prisma: PrismaService,
  year: number,
  month: number,
): Promise<MissingScheduleSummary[]> {
  const start = DateUtil.startOfMonth(year, month);
  const end = DateUtil.endOfMonth(year, month);
  const daysInMonth = new Date(year, month, 0).getDate();

  const hospitals = await prisma.hospital.findMany({
    where: { isBlocked: false },
    select: { id: true, name: true, schedulePlanningMode: true },
  });

  const result: MissingScheduleSummary[] = [];
  for (const hospital of hospitals) {
    const summary: MissingScheduleSummary = {
      hospitalId: hospital.id,
      hospitalName: hospital.name,
      employees: { total: 0, byDepartment: [] },
      posts: [],
    };

    if (hospital.schedulePlanningMode === 'POST_COVERAGE') {
      const posts = await prisma.schedulePost.findMany({
        where: { hospitalId: hospital.id, isActive: true },
        select: {
          name: true,
          plans: {
            where: { year, month },
            select: { status: true, version: true },
            orderBy: { version: 'desc' },
            take: 1,
          },
        },
        orderBy: { name: 'asc' },
      });
      for (const post of posts) {
        const status = post.plans[0]?.status ?? 'NONE';
        if (status === MonthlySchedulePlanStatus.APPROVED) continue;
        summary.posts.push({
          name: post.name,
          state: PLAN_STATE[status] ?? String(status).toLowerCase(),
        });
      }
    } else {
      const employees = await prisma.employee.findMany({
        where: {
          hospitalId: hospital.id,
          firedAt: null,
          hiredAt: { lte: end },
        },
        select: {
          department: { select: { name: true } },
          schedules: {
            where: { date: { gte: start, lte: end } },
            select: { status: true, note: true },
          },
        },
      });
      const byDepartment = new Map<string, number>();
      for (const employee of employees) {
        const work = employee.schedules.filter((row) => !isLeaveRow(row));
        const leaveDays = employee.schedules.length - work.length;
        // Grafik kiritilgan yoki butun oy ta'tilda — ogohlantirish shart emas
        if (work.length || leaveDays >= daysInMonth) continue;
        const name = employee.department?.name ?? "Bo'limsiz";
        byDepartment.set(name, (byDepartment.get(name) ?? 0) + 1);
        summary.employees.total++;
      }
      summary.employees.byDepartment = [...byDepartment].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      );
    }

    if (summary.employees.total || summary.posts.length) result.push(summary);
  }
  return result;
}

/** Ogohlantirish matni (Telegram — HTML, ilova/push — oddiy matn) */
export function missingScheduleMessage(
  summary: MissingScheduleSummary,
  year: number,
  month: number,
  daysLeft: number,
) {
  const monthName = UZ_MONTHS[month - 1];
  const title = `${monthName.charAt(0).toUpperCase()}${monthName.slice(1)} oyi grafigi kiritilmagan`;
  const lines: string[] = [];
  if (summary.employees.total) {
    const top = summary.employees.byDepartment
      .slice(0, 6)
      .map(([name, count]) => `${name} — ${count}`);
    const more = summary.employees.byDepartment.length - top.length;
    lines.push(
      `${summary.employees.total} ta xodimning ${monthName} grafigi yo'q.`,
      `Bo'limlar: ${top.join(', ')}${more > 0 ? ` va yana ${more} ta bo'lim` : ''}.`,
    );
  }
  if (summary.posts.length) {
    const top = summary.posts
      .slice(0, 6)
      .map((post) => `${post.name} (${post.state})`);
    const more = summary.posts.length - top.length;
    lines.push(
      `${summary.posts.length} ta post uchun ${monthName} rejasi tasdiqlanmagan: ${top.join(', ')}${more > 0 ? ` va yana ${more} ta` : ''}.`,
    );
  }
  // Grafiksiz xodimda kelmaganlik/kechikish grafik bo'yicha aniqlanmaydi,
  // maosh esa standart 5 kunlik (Du–Ju, 8 soat) me'yor bo'yicha hisoblanadi.
  const footer = `Yangi oyga ${daysLeft} kun qoldi. Grafik kiritilmasa, 1-${monthName}dan xodimlar «Grafik yo'q» holatida bo'ladi: kelmaganlik va kechikish aniqlanmaydi, maosh standart 5 kunlik me'yor bo'yicha hisoblanadi.`;
  const text = [...lines, footer].join('\n');
  const esc = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `⚠️ <b>${esc(title)}</b>\n🏥 ${esc(summary.hospitalName)}\n\n${esc(text)}`;
  return { title, text, html, year, month };
}
