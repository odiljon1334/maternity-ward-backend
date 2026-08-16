import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class BirthdayService {
  private readonly logger = new Logger(BirthdayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  @Cron('0 9 * * *', { timeZone: 'Asia/Tashkent' })
  async sendBirthdayNotifications() {
    this.logger.log('Birthday check started...');

    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    // Bugun tug'ilgan kunli FAOL xodimlar
    const employees = await this.prisma.employee.findMany({
      where: {
        status: 'ACTIVE',
        firedAt: null,
        birthDate: { not: null },
      },
    });

    const todayBirthdays = employees.filter((emp) => {
      if (!emp.birthDate) return false;
      const bd = new Date(emp.birthDate);
      return bd.getMonth() + 1 === month && bd.getDate() === day;
    });

    if (!todayBirthdays.length) {
      this.logger.log('No birthdays today.');
      return;
    }

    this.logger.log(`Found ${todayBirthdays.length} birthdays today.`);

    for (const emp of todayBirthdays) {
      const age = now.getFullYear() - new Date(emp.birthDate!).getFullYear();

      // 1. Xodimga shaxsiy tabrik
      if (emp.telegramChatId) {
        const empMsg =
          `🎂 <b>Tug'ilgan kuningiz bilan!</b>\n\n` +
          `Hurmatli <b>${emp.fullName}</b>,\n` +
          `Sizni ${age} yoshingiz bilan qutlaymiz! 🎉\n\n` +
          `Sizga mustahkam sog'liq, baxt va muvaffaqiyat tilaymiz! 🌟`;

        try {
          await this.telegram.sendToChat(emp.telegramChatId, empMsg);
        } catch (e) {
          this.logger.warn(`Failed to send to employee ${emp.fullName}: ${e}`);
        }
      }

      // 2. Direktorga xabar — hospitalId bo'yicha subscription topamiz
      const subs = await this.prisma.telegramSubscription.findMany({
        where: { hospitalId: emp.hospitalId, isActive: true },
      });

      if (!subs.length) continue;

      // Hospital nomini olish
      const hospital = await this.prisma.hospital.findUnique({
        where: { id: emp.hospitalId },
        select: { name: true },
      });

      const dirMsg =
        `🎂 <b>Bugun xodimning tug'ilgan kuni!</b>\n\n` +
        `👤 <b>${emp.fullName}</b>\n` +
        `🎂 Yosh: <b>${age}</b>\n` +
        `🏥 Kasalxona: ${hospital?.name || '—'}\n\n` +
        `Tabrikni unutmang! 🎉`;

      for (const sub of subs) {
        try {
          await this.telegram.sendToChat(sub.chatId, dirMsg);
        } catch (e) {
          this.logger.warn(`Failed to send to director ${sub.chatId}: ${e}`);
        }
      }
    }
  }
}
