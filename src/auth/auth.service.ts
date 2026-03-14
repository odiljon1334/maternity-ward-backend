import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
      include: {
        employee: {
          include: { department: true, position: true },
        },
      },
    });

    if (!user) throw new UnauthorizedException('Foydalanuvchi topilmadi');
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('Hisob bloklangan');

    const isMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isMatch) throw new UnauthorizedException('Parol noto\'g\'ri');

    const payload = { sub: user.id, role: user.role, username: user.username };
    const token = this.jwt.sign(payload);

    return {
      accessToken: token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        lang: user.lang,
        employee: user.employee,
      },
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    const isMatch = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!isMatch) throw new BadRequestException('Joriy parol noto\'g\'ri');

    const newHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    });

    return { message: 'Parol muvaffaqiyatli o\'zgartirildi' };
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
