import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RegisterDto } from './dto/register.dto';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly auditLog: AuditLogService,
  ) {}

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
      data: { passwordHash: newHash },
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
        employee: {
          include: { department: true, position: true },
        },
      },
    });
  }
}
