import {
  Controller, Post, Delete, Get, Body, Query,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { PushService } from './push.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@Controller('push')
@UseGuards(JwtAuthGuard)
export class PushController {
  constructor(private readonly svc: PushService) {}

  /** Browser push subscription'ni saqlash */
  @Post('subscribe')
  @HttpCode(HttpStatus.OK)
  subscribe(
    @CurrentUser('sub') userId: string,
    @Body() body: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
      userAgent?: string;
    },
  ) {
    return this.svc.subscribe(userId, body);
  }

  /** Subscription'ni o'chirish */
  @Delete('unsubscribe')
  @HttpCode(HttpStatus.OK)
  unsubscribe(
    @CurrentUser('sub') userId: string,
    @Body('endpoint') endpoint: string,
  ) {
    return this.svc.unsubscribe(userId, endpoint);
  }

  /** VAPID public key (frontend uchun) */
  @Get('vapid-key')
  getVapidKey() {
    return { publicKey: process.env.VAPID_PUBLIC_KEY ?? '' };
  }

  /** Test push (faqat SUPER_ADMIN) */
  @Post('test')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  testPush(
    @CurrentUser('sub') userId: string,
    @Body() body: { title?: string; body?: string },
  ) {
    return this.svc.sendToUser(userId, {
      title: body.title ?? 'Test xabarnoma 🔔',
      body:  body.body  ?? 'Push notification ishlayapti!',
      url:   '/dashboard',
      tag:   'test',
    });
  }
}
