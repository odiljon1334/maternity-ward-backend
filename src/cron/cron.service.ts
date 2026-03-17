import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AttendanceService } from '../attendance/attendance.service';
import { TelegramService } from '../telegram/telegram.service';
import { PrismaService } from '../prisma/prisma.service';
import { DateUtil } from '../common/utils/date.util';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly telegramService: TelegramService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Har kuni kechqurun 21:00 da — kelmagan hodimlarni ABSENT deb belgilaydi
   * Night shift hodimlar bundan mustasno (ular 20:00 da kelishi kerak)
   */
  @Cron('0 21 * * *', { timeZone: process.env.TIMEZONE || 'Asia/Tashkent' })
  async markAbsentDaily() {
    this.logger.log('Running daily absent marker...');
    try {
      const result = await this.attendanceService.markAbsentForToday();
      this.logger.log(`Absent marked: ${result.marked} employees`);
    } catch (err) {
      this.logger.error('markAbsentDaily failed:', err);
    }
  }

  /**
   * Har kuni 10:00 da (ish kunlari) — kech kelganlar va hali kelmagan hodimlar
   * Faqat kunduzgi smen uchun (night shift 20:00 da keladi)
   */
  @Cron('0 10 * * 1-6', { timeZone: process.env.TIMEZONE || 'Asia/Tashkent' })
  async lateArrivalAlert() {
    this.logger.log('Sending late arrival alert...');
    try {
      const today = DateUtil.startOfDay(new Date());
      const todayStr = new Date().toISOString().slice(0, 10);

      const subs = await this.prisma.telegramSubscription.findMany({
        where: { isActive: true, hospitalId: { not: null } },
      });
      const hospitalIds = [...new Set(subs.map(s => s.hospitalId).filter(Boolean))] as string[];

      for (const hospitalId of hospitalIds) {
        const hospital = await this.prisma.hospital.findUnique({ where: { id: hospitalId } });
        if (!hospital || hospital.isBlocked) continue;

        const hospitalSubs = subs.filter(s => s.hospitalId === hospitalId);
        if (!hospitalSubs.length) continue;

        // Bugun kunduzgi smenda ishlashi kerak bo'lgan hodimlar + ularning davomati
        const schedules = await this.prisma.schedule.findMany({
          where: {
            date: today,
            status: 'WORKING',
            employee: { hospitalId },
            shift: { type: 'DAYTIME' },
          },
          include: {
            employee: { include: { department: true } },
            shift: true,
            attendance: true,
          },
        });

        if (!schedules.length) continue;

        const late    = schedules.filter(s => s.attendance?.status === 'LATE' || s.attendance?.status === 'LATE_EARLY');
        const absent  = schedules.filter(s => !s.attendance || s.attendance.status === 'ABSENT');
        const onTime  = schedules.length - late.length - absent.length;

        // Hamma keldi — qisqa xabar
        if (late.length === 0 && absent.length === 0) {
          const msg =
            `✅ <b>${todayStr} — 10:00 holati</b>\n\n` +
            `Kunduzgi smendagi barcha <b>${schedules.length}</b> nafar hodim o'z vaqtida keldi! 🎉`;
          for (const sub of hospitalSubs) {
            try { await this.telegramService.sendToChat(sub.chatId, msg); } catch { /* skip */ }
          }
          continue;
        }

        let msg = `⏰ <b>Kech kelish hisoboti — ${todayStr}</b>\n\n`;

        if (late.length > 0) {
          msg += `🟡 <b>Kech kelganlar (${late.length} nafar):</b>\n`;
          msg += late.slice(0, 10)
            .map(s => `  • ${s.employee.fullName} — ${s.attendance!.lateMinutes} daq kech`)
            .join('\n');
          if (late.length > 10) msg += `\n  ... va yana ${late.length - 10} nafar`;
          msg += '\n\n';
        }

        if (absent.length > 0) {
          msg += `🔴 <b>Hali kelmadi (${absent.length} nafar):</b>\n`;
          msg += absent.slice(0, 10)
            .map(s => `  • ${s.employee.fullName} (${s.employee.department?.name ?? ''})`)
            .join('\n');
          if (absent.length > 10) msg += `\n  ... va yana ${absent.length - 10} nafar`;
          msg += '\n\n';
        }

        msg +=
          `📊 <b>Jami:</b> ${schedules.length} nafar\n` +
          `✅ O'z vaqtida: ${onTime} | 🟡 Kech: ${late.length} | 🔴 Kelmadi: ${absent.length}`;

        for (const sub of hospitalSubs) {
          try { await this.telegramService.sendToChat(sub.chatId, msg); } catch { /* skip */ }
        }
      }
    } catch (err) {
      this.logger.error('lateArrivalAlert failed:', err);
    }
  }

  /**
   * Har kuni ertalab 08:30 da — bugun ish kuni bo'lgan hodimlar ro'yxati
   * Telegram orqali direktorga yuboriladi
   */
  @Cron('30 8 * * 1-6', { timeZone: process.env.TIMEZONE || 'Asia/Tashkent' })
  async morningReport() {
    this.logger.log('Sending morning report...');
    try {
      const today = new Date().toISOString().slice(0, 10);

      // Faqat hospitalId bor subscriberlarni olish (null = ulanmagan = skip)
      const subs = await this.prisma.telegramSubscription.findMany({
        where: { isActive: true, hospitalId: { not: null } },
      });
      const hospitalIds = [...new Set(subs.map(s => s.hospitalId).filter(Boolean))] as string[];

      for (const hospitalId of hospitalIds) {
        const hospital = await this.prisma.hospital.findUnique({ where: { id: hospitalId } });
        if (!hospital || hospital.isBlocked) continue;

        const hospitalSubs = subs.filter(s => s.hospitalId === hospitalId);
        if (!hospitalSubs.length) continue;

        const schedules = await this.prisma.schedule.findMany({
          where: {
            date: DateUtil.startOfDay(new Date()),
            status: 'WORKING',
            employee: { hospitalId },   // doim filter qilamiz
          },
          include: { employee: { include: { department: true } }, shift: true },
        });

        if (!schedules.length) continue;

        const dayShift   = schedules.filter(s => s.shift?.type === 'DAYTIME');
        const nightShift = schedules.filter(s => s.shift?.type === 'NIGHTTIME');
        const other      = schedules.filter(s => !s.shift || (s.shift.type !== 'DAYTIME' && s.shift.type !== 'NIGHTTIME'));

        let msg =
          `📋 <b>Bugungi ish jadvali (${today})</b>\n` +
          `🏥 <b>${hospital.name}</b>\n\n` +
          `☀️ <b>Kunduzgi smen: ${dayShift.length} nafar</b>\n` +
          dayShift.slice(0, 15).map(s => `  • ${s.employee.fullName}`).join('\n') +
          (dayShift.length > 15 ? `\n  ... va yana ${dayShift.length - 15} nafar` : '') +
          `\n\n🌙 <b>Kechki smen: ${nightShift.length} nafar</b>`;

        if (nightShift.length > 0) {
          msg += '\n' + nightShift.slice(0, 10).map(s => `  • ${s.employee.fullName}`).join('\n');
          if (nightShift.length > 10) msg += `\n  ... va yana ${nightShift.length - 10} nafar`;
        }

        if (other.length > 0) {
          msg += `\n\n📌 <b>Boshqa: ${other.length} nafar</b>\n`;
          msg += other.slice(0, 5).map(s => `  • ${s.employee.fullName}`).join('\n');
        }

        msg += `\n\n👥 <b>Jami: ${schedules.length} nafar</b>`;

        for (const sub of hospitalSubs) {
          try { await this.telegramService.sendToChat(sub.chatId, msg); } catch { /* skip */ }
        }
      }
    } catch (err) {
      this.logger.error('morningReport failed:', err);
    }
  }

  /**
   * Har dushanba 09:00 da — o'tgan hafta hisoboti
   */
  @Cron('0 9 * * 1', { timeZone: process.env.TIMEZONE || 'Asia/Tashkent' })
  async weeklyReport() {
    this.logger.log('Sending weekly report via Telegram...');
    try {
      const lastWeekStart = new Date();
      lastWeekStart.setDate(lastWeekStart.getDate() - 7);
      const weekStartDate = DateUtil.startOfWeek(lastWeekStart);

      // Per-hospital yuborish
      const subs = await this.prisma.telegramSubscription.findMany({
        where: { isActive: true, hospitalId: { not: null } },
      });
      const hospitalIds = [...new Set(subs.map(s => s.hospitalId).filter(Boolean))] as string[];

      for (const hospitalId of hospitalIds) {
        const hospital = await this.prisma.hospital.findUnique({ where: { id: hospitalId } });
        if (!hospital || hospital.isBlocked) continue;

        const hospitalSubs = subs.filter(s => s.hospitalId === hospitalId);
        if (!hospitalSubs.length) continue;

        const stats = await this.prisma.weeklyAttendanceStat.findMany({
          where: { weekStart: weekStartDate, employee: { hospitalId } },
          include: { employee: { include: { department: true } } },
          orderBy: { totalLateMin: 'desc' },
        });

        let msg: string;

        if (!stats.length) {
          msg = `📊 <b>Haftalik hisobot — ${hospital.name}</b>\n\nO'tgan hafta ma'lumot topilmadi.`;
        } else {
          const totalLate = stats.reduce((s, r) => s + r.totalLateMin, 0);
          const totalAbsent = stats.reduce((s, r) => s + r.daysAbsent, 0);
          const totalDeductions = stats.reduce((s, r) => s + Number(r.deductionAmount), 0);

          const problemEmployees = stats
            .filter(s => s.totalLateMin > 30 || s.daysAbsent > 0)
            .slice(0, 8)
            .map(s => `  • ${s.employee.fullName}: ${s.totalLateMin} min kech, ${s.daysAbsent} kun yo'q`)
            .join('\n');

          msg =
            `📊 <b>Haftalik hisobot — ${hospital.name}</b>\n\n` +
            `👥 Hodimlar: ${stats.length} nafar\n` +
            `⏱ Kechikish: ${totalLate} daqiqa\n` +
            `❌ Yo'qlik: ${totalAbsent} kun\n` +
            `💰 Kesimlar: ${Math.round(totalDeductions).toLocaleString()} so'm\n\n` +
            (problemEmployees ? `⚠️ <b>Diqqat talab etuvchilar:</b>\n${problemEmployees}` : '✅ Hamma yaxshi!');
        }

        for (const sub of hospitalSubs) {
          try { await this.telegramService.sendToChat(sub.chatId, msg); } catch { /* skip */ }
        }
      }
    } catch (err) {
      this.logger.error('weeklyReport failed:', err);
    }
  }

  /**
   * Har oyning 1-kuni 09:00 da — oylik statistika
   */
  @Cron('0 9 1 * *', { timeZone: process.env.TIMEZONE || 'Asia/Tashkent' })
  async monthlyReport() {
    this.logger.log('Sending monthly report via Telegram...');
    try {
      const prevMonth = new Date();
      prevMonth.setMonth(prevMonth.getMonth() - 1);
      const month = prevMonth.getMonth() + 1;
      const year = prevMonth.getFullYear();

      const monthNames = ['', 'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
        'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];

      // Per-hospital yuborish
      const subs = await this.prisma.telegramSubscription.findMany({
        where: { isActive: true, hospitalId: { not: null } },
      });
      const hospitalIds = [...new Set(subs.map(s => s.hospitalId).filter(Boolean))] as string[];

      for (const hospitalId of hospitalIds) {
        const hospital = await this.prisma.hospital.findUnique({ where: { id: hospitalId } });
        if (!hospital || hospital.isBlocked) continue;

        const hospitalSubs = subs.filter(s => s.hospitalId === hospitalId);
        if (!hospitalSubs.length) continue;

        const payrolls = await this.prisma.payrollRecord.findMany({
          where: { month, year, employee: { hospitalId } },
          include: { employee: true },
        });

        let msg: string;

        if (!payrolls.length) {
          msg = `📋 <b>${hospital.name}</b>\n${monthNames[month]} ${year} uchun maosh hisoblari mavjud emas`;
        } else {
          const totalNet = payrolls.reduce((s, p) => s + Number(p.netSalary), 0);
          const totalDeductions = payrolls.reduce(
            (s, p) => s + Number(p.lateDeduction) + Number(p.absenceDeduction) + Number(p.earlyLeaveDeduction),
            0,
          );
          const totalAbsences = payrolls.reduce((s, p) => s + p.totalAbsences, 0);

          msg =
            `📅 <b>${monthNames[month]} ${year} — Oylik hisobot</b>\n` +
            `🏥 <b>${hospital.name}</b>\n\n` +
            `👥 Hodimlar: ${payrolls.length} nafar\n` +
            `❌ Yo'qlik: ${totalAbsences} kun\n` +
            `📉 Kesimlar: ${Math.round(totalDeductions).toLocaleString()} so'm\n` +
            `💵 Net maosh: <b>${Math.round(totalNet).toLocaleString()} so'm</b>\n\n` +
            `<i>Batafsil — tizimga kiring yoki /month</i>`;
        }

        for (const sub of hospitalSubs) {
          try { await this.telegramService.sendToChat(sub.chatId, msg); } catch { /* skip */ }
        }
      }
    } catch (err) {
      this.logger.error('monthlyReport failed:', err);
    }
  }
}
