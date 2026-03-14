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
   * Har kuni ertalab 08:30 da — bugun ish kuni bo'lgan hodimlar ro'yxati
   * Telegram orqali direktorga yuboriladi
   */
  @Cron('30 8 * * 1-6', { timeZone: process.env.TIMEZONE || 'Asia/Tashkent' })
  async morningReport() {
    this.logger.log('Sending morning report...');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const schedules = await this.prisma.schedule.findMany({
        where: {
          date: DateUtil.startOfDay(new Date()),
          status: 'WORKING',
        },
        include: {
          employee: { include: { department: true } },
          shift: true,
        },
      });

      if (!schedules.length) return;

      const dayShift = schedules.filter(s => s.shift?.type === 'DAYTIME');
      const nightShift = schedules.filter(s => s.shift?.type === 'NIGHTTIME');

      const msg =
        `📋 <b>Bugungi ish jadvali (${today})</b>\n\n` +
        `☀️ <b>Kunduzgi smen (08:00–20:00): ${dayShift.length} nafar</b>\n` +
        dayShift.slice(0, 10).map(s => `  • ${s.employee.fullName}`).join('\n') +
        (dayShift.length > 10 ? `\n  ... va yana ${dayShift.length - 10} nafar` : '') +
        `\n\n🌙 <b>Kechki smen (20:00–08:00): ${nightShift.length} nafar</b>\n` +
        nightShift.slice(0, 10).map(s => `  • ${s.employee.fullName}`).join('\n') +
        (nightShift.length > 10 ? `\n  ... va yana ${nightShift.length - 10} nafar` : '');

      await this.telegramService.broadcast(msg);
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

      const stats = await this.prisma.weeklyAttendanceStat.findMany({
        where: { weekStart: DateUtil.startOfWeek(lastWeekStart) },
        include: { employee: { include: { department: true } } },
        orderBy: { totalLateMin: 'desc' },
      });

      if (!stats.length) {
        await this.telegramService.broadcast('📊 <b>Haftalik hisobot:</b> O\'tgan hafta ma\'lumot topilmadi');
        return;
      }

      const totalLate = stats.reduce((s, r) => s + r.totalLateMin, 0);
      const totalAbsent = stats.reduce((s, r) => s + r.daysAbsent, 0);
      const totalDeductions = stats.reduce((s, r) => s + Number(r.deductionAmount), 0);

      const problemEmployees = stats
        .filter(s => s.totalLateMin > 30 || s.daysAbsent > 0)
        .slice(0, 5)
        .map(s => `  • ${s.employee.fullName}: ${s.totalLateMin} min kech, ${s.daysAbsent} kun yo'q`)
        .join('\n');

      const msg =
        `📊 <b>Haftalik davomat hisoboti</b>\n\n` +
        `👥 Jami hodimlar: ${stats.length}\n` +
        `⏱ Umumiy kechikish: ${totalLate} daqiqa\n` +
        `❌ Yo'qlik kunlar: ${totalAbsent}\n` +
        `💰 Kesimlar: ${Math.round(totalDeductions).toLocaleString()} so'm\n\n` +
        (problemEmployees ? `⚠️ <b>Diqqat talab etuvchilar:</b>\n${problemEmployees}` : '✅ Hamma yaxshi!');

      await this.telegramService.broadcast(msg);
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

      const payrolls = await this.prisma.payrollRecord.findMany({
        where: { month, year },
        include: { employee: true },
      });

      if (!payrolls.length) {
        await this.telegramService.broadcast(`📋 ${month}/${year} uchun maosh hisoblari mavjud emas`);
        return;
      }

      const totalNet = payrolls.reduce((s, p) => s + Number(p.netSalary), 0);
      const totalDeductions = payrolls.reduce(
        (s, p) => s + Number(p.lateDeduction) + Number(p.absenceDeduction) + Number(p.earlyLeaveDeduction),
        0,
      );
      const totalAbsences = payrolls.reduce((s, p) => s + p.totalAbsences, 0);

      const monthNames = ['', 'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
        'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];

      const msg =
        `📅 <b>${monthNames[month]} ${year} — Oylik hisobot</b>\n\n` +
        `👥 Hodimlar: ${payrolls.length} nafar\n` +
        `❌ Jami yo'qlik: ${totalAbsences} kun\n` +
        `📉 Jami kesimlar: ${Math.round(totalDeductions).toLocaleString()} so'm\n` +
        `💵 Jami net maosh: <b>${Math.round(totalNet).toLocaleString()} so'm</b>\n\n` +
        `<i>Batafsil — tizimga kiring yoki /month</i>`;

      await this.telegramService.broadcast(msg);
    } catch (err) {
      this.logger.error('monthlyReport failed:', err);
    }
  }
}
