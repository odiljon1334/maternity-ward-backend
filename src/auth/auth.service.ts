import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MailService } from '../mail/mail.service';
import { TelegramService } from '../telegram/telegram.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RegisterDto } from './dto/register.dto';
import { UpdateEmailDto } from './dto/update-email.dto';
import { VerifyEmailOtpDto } from './dto/verify-email-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyResetOtpDto } from './dto/verify-reset-otp.dto';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

/** Bitta OTP kodga noto'g'ri urinishlar chegarasi */
const RESET_OTP_MAX_ATTEMPTS = 5;
/** Bitta hisob uchun soatiga yuboriladigan parol tiklash kodlari */
const RESET_OTP_PER_HOUR = 3;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly auditLog: AuditLogService,
    private readonly mailService: MailService,
    private readonly telegramService: TelegramService,
    private readonly config: ConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────
  // Yordamchi metodlar — OTP/token generatsiya va hash
  // ─────────────────────────────────────────────────────────

  /** 6 xonali raqamli OTP kod (masalan "042917") */
  private generateOtp(): string {
    return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  /** URL-safe uzun token (parolni tiklash havolasi uchun) */
  private generateResetToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private hash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  /**
   * OTP xeshi foydalanuvchiga bog'lanadi: 6 xonali kod bor-yo'g'i 1M
   * variant, `tokenHash` esa @unique — ikki foydalanuvchiga bir xil kod
   * tushsa, oddiy xesh unique xatosiga olib kelardi.
   */
  private otpHash(userId: string, code: string): string {
    return this.hash(`otp:${userId}:${code}`);
  }

  private safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  /** Frontend bazaviy URL — CORS uchun ishlatilgan FRONTEND_URL bilan bir xil manba */
  private getFrontendUrl(): string {
    const raw =
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    return raw.split(',')[0].trim();
  }

  async login(dto: LoginDto, ip?: string) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
      include: {
        hospital: {
          select: {
            id: true,
            name: true,
            code: true,
            gpsLat: true,
            gpsLng: true,
            gpsRadius: true,
          },
        },
        employee: {
          include: { department: true, position: true },
        },
      },
    });

    // Foydalanuvchi topilmadi
    if (!user) {
      this.auditLog.log({
        action: 'LOGIN_FAILED',
        entity: 'User',
        details: { username: dto.username, reason: 'user_not_found' },
        ip,
      });
      throw new UnauthorizedException('Foydalanuvchi topilmadi');
    }

    // Hisob bloklangan
    if (user.status !== 'ACTIVE') {
      this.auditLog.log({
        userId: user.id,
        hospitalId: user.hospitalId ?? undefined,
        action: 'LOGIN_FAILED',
        entity: 'User',
        entityId: user.id,
        details: { username: user.username, reason: 'account_blocked' },
        ip,
      });
      throw new UnauthorizedException('Hisob bloklangan');
    }

    // Noto'g'ri parol
    const isMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isMatch) {
      this.auditLog.log({
        userId: user.id,
        hospitalId: user.hospitalId ?? undefined,
        action: 'LOGIN_FAILED',
        entity: 'User',
        entityId: user.id,
        details: { username: user.username, reason: 'wrong_password' },
        ip,
      });
      throw new UnauthorizedException("Parol noto'g'ri");
    }

    const payload = {
      sub: user.id,
      role: user.role,
      username: user.username,
      hospitalId: user.hospitalId ?? null,
    };
    const token = this.jwt.sign(payload);

    // Oxirgi kirish vaqtini yangilash — panel'dagi "faol foydalanuvchilar"
    // ro'yxati shu maydonga tayanadi (fire-and-forget, login jarayonini
    // sekinlashtirmaydi)
    this.prisma.user
      .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      .catch(() => {
        /* silent */
      });

    // Muvaffaqiyatli kirish
    this.auditLog.log({
      userId: user.id,
      hospitalId: user.hospitalId ?? undefined,
      action: 'LOGIN',
      entity: 'User',
      entityId: user.id,
      details: { username: user.username, role: user.role },
      ip,
    });

    return {
      accessToken: token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        lang: user.lang,
        hospitalId: user.hospitalId,
        hospital: user.hospital,
        employee: user.employee,
      },
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto, ip?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    const isMatch = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!isMatch) throw new BadRequestException("Joriy parol noto'g'ri");

    const newHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash, credentialsChangedAt: new Date() },
    });

    this.auditLog.log({
      userId,
      hospitalId: user.hospitalId ?? undefined,
      action: 'CHANGE_PASSWORD',
      entity: 'User',
      entityId: userId,
      ip,
    });

    return { message: "Parol muvaffaqiyatli o'zgartirildi" };
  }

  async register(dto: RegisterDto, createdByUserId?: string) {
    const exists = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });
    if (exists) throw new ConflictException('Bu username band');

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const role = dto.role ?? UserRole.ASSISTANT_ADMIN;

    const user = await this.prisma.user.create({
      data: { username: dto.username, passwordHash, role },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });

    this.auditLog.log({
      userId: createdByUserId,
      action: 'REGISTER',
      entity: 'User',
      entityId: user.id,
      details: { username: user.username, role: user.role },
    });

    return user;
  }

  async getProfile(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        lang: true,
        email: true,
        emailVerifiedAt: true,
        employee: {
          include: { department: true, position: true },
        },
        // Tenant branding (2026-09-19): sidebar/topbar'da shifoxonaning
        // o'z logotipi/nomi ko'rsatilishi uchun — additive, mavjud
        // maydonlarga ta'sir qilmaydi.
        hospital: {
          select: { id: true, name: true, logoUrl: true },
        },
      },
    });
  }

  // ─────────────────────────────────────────────────────────
  // Email tasdiqlash
  // ─────────────────────────────────────────────────────────

  /** Foydalanuvchi profiliga email qo'shadi/yangilaydi va OTP yuboradi (hali tasdiqlanmagan holatda) */
  async updateEmail(userId: string, dto: UpdateEmailDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing && existing.id !== userId) {
      throw new ConflictException(
        "Bu email boshqa foydalanuvchida ro'yxatdan o'tgan",
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { employee: true },
    });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');

    // Email o'zgarsa — qayta tasdiqlash talab qilinadi
    await this.prisma.user.update({
      where: { id: userId },
      data: { email: dto.email, emailVerifiedAt: null },
    });

    return this.sendEmailOtpInternal(
      userId,
      dto.email,
      user.employee?.fullName,
    );
  }

  /** Joriy (hali tasdiqlanmagan) emailga OTP kodni qayta yuborish */
  async resendEmailOtp(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { employee: true },
    });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    if (!user.email) throw new BadRequestException('Avval email kiriting');
    if (user.emailVerifiedAt) {
      throw new BadRequestException('Email allaqachon tasdiqlangan');
    }

    return this.sendEmailOtpInternal(
      userId,
      user.email,
      user.employee?.fullName,
    );
  }

  private async sendEmailOtpInternal(
    userId: string,
    email: string,
    fullName?: string,
  ) {
    // Oldingi ishlatilmagan kodlarni bekor qilish (bir vaqtda faqat bitta faol kod)
    await this.prisma.emailOtpToken.updateMany({
      where: { userId, purpose: 'EMAIL_VERIFY', consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const code = this.generateOtp();
    await this.prisma.emailOtpToken.create({
      data: {
        userId,
        codeHash: this.hash(code),
        purpose: 'EMAIL_VERIFY',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 daqiqa
      },
    });

    const sent = await this.mailService.sendOtpEmail(email, code, fullName);
    if (!sent) {
      this.auditLog.log({
        userId,
        action: 'EMAIL_OTP_SEND_FAILED',
        entity: 'User',
        entityId: userId,
        details: { email },
      });
    }

    return { message: 'Tasdiqlash kodi emailga yuborildi' };
  }

  /** Foydalanuvchi kiritgan OTP kodni tekshirib, emailni tasdiqlaydi */
  async verifyEmailOtp(userId: string, dto: VerifyEmailOtpDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.email) throw new BadRequestException('Avval email kiriting');

    const token = await this.prisma.emailOtpToken.findFirst({
      where: {
        userId,
        purpose: 'EMAIL_VERIFY',
        consumedAt: null,
        expiresAt: { gte: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token) {
      throw new BadRequestException("Kod muddati o'tgan — qaytadan so'rang");
    }
    if (token.attempts >= 5) {
      throw new BadRequestException(
        "Urinishlar soni tugadi — qaytadan so'rang",
      );
    }

    if (token.codeHash !== this.hash(dto.code)) {
      await this.prisma.emailOtpToken.update({
        where: { id: token.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException("Kod noto'g'ri");
    }

    await this.prisma.$transaction([
      this.prisma.emailOtpToken.update({
        where: { id: token.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: new Date() },
      }),
    ]);

    this.auditLog.log({
      userId,
      action: 'EMAIL_VERIFIED',
      entity: 'User',
      entityId: userId,
      details: { email: user.email },
    });

    return { message: 'Email muvaffaqiyatli tasdiqlandi' };
  }

  // ─────────────────────────────────────────────────────────
  // Parolni tiklash (forgot password)
  // Ustuvorlik: tasdiqlangan email → link; aks holda Telegram OTP;
  // Telegram ham yo'q bo'lsa — hozircha xabar (SMS keyingi bosqichda qo'shiladi).
  // ─────────────────────────────────────────────────────────

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
      include: { employee: true },
    });

    // Xavfsizlik: foydalanuvchi mavjud/mavjud emasligini oshkor qilmaymiz
    const generic = {
      message: "Agar hisob mavjud bo'lsa, tiklash bo'yicha ko'rsatma yuborildi",
    };
    if (!user) return generic;

    if (user.email && user.emailVerifiedAt) {
      const rawToken = this.generateResetToken();
      await this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: this.hash(rawToken),
          channel: 'EMAIL',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 daqiqa
        },
      });
      const resetUrl = `${this.getFrontendUrl()}/reset-password?token=${rawToken}`;
      await this.mailService.sendPasswordResetEmail(
        user.email,
        resetUrl,
        user.employee?.fullName,
      );
      return { ...generic, channel: 'EMAIL' };
    }

    const chatId = user.employee?.telegramChatId;
    if (chatId) {
      // Bitta hisob uchun soatiga ko'pi bilan RESET_OTP_PER_HOUR ta kod —
      // turli IP'lardan cheksiz kod so'rab, har biriga urinib ko'rish
      // (va Telegram spami) yopiladi. Javob baribir umumiy.
      const recent = await this.prisma.passwordResetToken.count({
        where: {
          userId: user.id,
          channel: 'TELEGRAM',
          createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
      });
      if (recent >= RESET_OTP_PER_HOUR) {
        this.auditLog.log({
          userId: user.id,
          action: 'PASSWORD_RESET_RATE_LIMITED',
          entity: 'User',
          entityId: user.id,
          details: { channel: 'TELEGRAM' },
        });
        return { ...generic, channel: 'TELEGRAM' };
      }
      const code = this.generateOtp();
      await this.prisma.$transaction([
        // Oldingi ishlatilmagan kodlar bekor — faqat oxirgisi amal qiladi
        this.prisma.passwordResetToken.updateMany({
          where: {
            userId: user.id,
            channel: { in: ['TELEGRAM', 'SMS'] },
            consumedAt: null,
          },
          data: { consumedAt: new Date() },
        }),
        this.prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: this.otpHash(user.id, code),
            channel: 'TELEGRAM',
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          },
        }),
      ]);
      await this.telegramService.sendToChat(
        chatId,
        `🔐 Parolni tiklash kodi: <b>${code}</b>\n\nKod 10 daqiqa amal qiladi. Agar bu so'rovni siz yubormagan bo'lsangiz, e'tiborsiz qoldiring.`,
      );
      return { ...generic, channel: 'TELEGRAM' };
    }

    // TODO (Faza 1.1 — SMS zaxira): Employee.phone orqali SMS provayder
    // tanlangandan keyin shu yerga qo'shiladi. Hozircha email ham,
    // Telegram ham yo'q foydalanuvchi uchun tiklash imkoni yo'q —
    // audit-log'ga yozib qo'yamiz, admin qo'lda hal qiladi.
    this.auditLog.log({
      userId: user.id,
      action: 'PASSWORD_RESET_NO_CHANNEL',
      entity: 'User',
      entityId: user.id,
      details: { username: user.username },
    });
    return generic;
  }

  /** Email havolasidan kelgan token bilan parolni tiklash */
  async resetPassword(dto: ResetPasswordDto) {
    const tokenHash = this.hash(dto.token);
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (
      !record ||
      record.consumedAt ||
      record.expiresAt < new Date() ||
      record.channel !== 'EMAIL'
    ) {
      throw new BadRequestException("Havola yaroqsiz yoki muddati o'tgan");
    }

    const newHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash: newHash, credentialsChangedAt: new Date() },
      }),
    ]);

    this.auditLog.log({
      userId: record.userId,
      action: 'PASSWORD_RESET',
      entity: 'User',
      entityId: record.userId,
      details: { channel: 'EMAIL' },
    });

    return { message: 'Parol muvaffaqiyatli tiklandi' };
  }

  /** Telegram/SMS orqali kelgan OTP kod bilan parolni tiklash */
  async verifyResetOtp(dto: VerifyResetOtpDto) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });
    if (!user)
      throw new BadRequestException("Kod noto'g'ri yoki muddati o'tgan");

    const record = await this.prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        channel: { in: ['TELEGRAM', 'SMS'] },
        consumedAt: null,
        expiresAt: { gte: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record || record.attempts >= RESET_OTP_MAX_ATTEMPTS) {
      throw new BadRequestException("Kod noto'g'ri yoki muddati o'tgan");
    }
    const code = String(dto.code ?? '').trim();
    const ok =
      this.safeEqual(record.tokenHash, this.otpHash(user.id, code)) ||
      // Deploy paytida yuborilgan eski formatdagi kod (10 daqiqa amal qiladi)
      this.safeEqual(record.tokenHash, this.hash(code));
    if (!ok) {
      // Urinish atomik oshiriladi; limitga yetganda kod yopiladi
      const updated = await this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });
      if (updated.attempts >= RESET_OTP_MAX_ATTEMPTS) {
        await this.prisma.passwordResetToken.update({
          where: { id: record.id },
          data: { consumedAt: new Date() },
        });
        this.auditLog.log({
          userId: user.id,
          action: 'PASSWORD_RESET_OTP_LOCKED',
          entity: 'User',
          entityId: user.id,
          details: { channel: record.channel },
        });
        throw new BadRequestException(
          "Urinishlar soni tugadi. Yangi kod so'rang.",
        );
      }
      throw new BadRequestException("Kod noto'g'ri yoki muddati o'tgan");
    }

    const newHash = await bcrypt.hash(dto.newPassword, 12);
    // Parallel ikkita to'g'ri so'rov bitta kodni ikki marta ishlata olmasin
    const claimed = await this.prisma.passwordResetToken.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("Kod noto'g'ri yoki muddati o'tgan");
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash, credentialsChangedAt: new Date() },
      }),
    ]);

    this.auditLog.log({
      userId: user.id,
      action: 'PASSWORD_RESET',
      entity: 'User',
      entityId: user.id,
      details: { channel: record.channel },
    });

    return { message: 'Parol muvaffaqiyatli tiklandi' };
  }
}
