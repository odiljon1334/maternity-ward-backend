import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  tokenFromCookie,
  verifySocketUser,
} from '../common/utils/ws-auth.util';

@WebSocketGateway({
  namespace: '/live-location',
  // HttpOnly sessiya cookie polling fallback bilan ham yuborilishi uchun
  // wildcard CORS ishlatilmaydi.
  cors: {
    origin:
      process.env.FRONTEND_URL?.split(',').map((origin) => origin.trim()) ??
      true,
    credentials: true,
  },
})
export class LocationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  handleConnection(client: Socket) {
    console.log(`[LiveLocation] connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`[LiveLocation] disconnected: ${client.id}`);
  }

  @SubscribeMessage('join:admin')
  async handleAdminJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { token?: string },
  ) {
    // Yangi browser UI HttpOnly cookie ishlatadi; eski clientlar esa
    // rollout davomida tokenni event payload'ida yuborishi mumkin.
    // Tekshiruv HTTP bilan bir xil: bazada ACTIVE, parol almashgan bo'lsa
    // eski token rad etiladi (ilgari faqat imzo tekshirilardi).
    const token =
      tokenFromCookie(client.handshake.headers.cookie) ??
      (typeof payload?.token === 'string' ? payload.token : null);
    const user = await verifySocketUser(this.jwtService, this.prisma, token);
    if (!user) {
      client.emit('join:error', { message: "Token noto'g'ri" });
      return;
    }

    if (user.role === UserRole.SUPER_ADMIN || user.role === UserRole.MINISTRY) {
      // SUPER_ADMIN/MINISTRY barcha hospital room'lariga kiradi
      await client.join('super-admins');
      client.emit('join:success', { room: 'super-admins' });
      return;
    }

    if (user.role === UserRole.ASSISTANT_ADMIN) {
      // JWT'da muassasa yo'q — biriktirilgan muassasalar room'lariga
      const links = await this.prisma.hospitalAssistant.findMany({
        where: { userId: user.id },
        select: { hospitalId: true },
      });
      const rooms = links.map((l) => `hospital:${l.hospitalId}`);
      if (!rooms.length) {
        client.emit('join:error', { message: "Ruxsat yo'q" });
        return;
      }
      await client.join(rooms);
      client.emit('join:success', { room: rooms[0], rooms });
      return;
    }

    const adminRoles: UserRole[] = [
      UserRole.DIRECTOR,
      UserRole.ADMIN,
      UserRole.DEPARTMENT_HEAD,
    ];
    if (!adminRoles.includes(user.role) || !user.hospitalId) {
      client.emit('join:error', { message: "Ruxsat yo'q" });
      return;
    }
    await client.join(`hospital:${user.hospitalId}`);
    client.emit('join:success', { room: `hospital:${user.hospitalId}` });
  }

  broadcastLocation(hospitalId: string, data: object) {
    this.server.to(`hospital:${hospitalId}`).emit('location:update', data);
    this.server.to('super-admins').emit('location:update', data);
  }

  /** Xodim check-out qilganda live xaritadan darhol olib tashlash uchun signal */
  broadcastLocationRemoved(hospitalId: string, userId: string) {
    this.server
      .to(`hospital:${hospitalId}`)
      .emit('location:remove', { userId });
    this.server.to('super-admins').emit('location:remove', { userId });
  }

  /**
   * Terminal yoki mobil ilova orqali kelgan/ketgan xodim — dashboarddagi
   * "Real-time keldi/ketdi" kartochkasi uchun.
   *
   * `server` hali ko'tarilmagan bo'lishi mumkin (masalan test muhitida yoki
   * ishga tushish paytida) — shuning uchun himoyalangan chaqiruv.
   */
  broadcastAttendance(hospitalId: string | null, data: object) {
    if (!this.server) return;
    if (hospitalId) {
      this.server.to(`hospital:${hospitalId}`).emit('attendance:event', data);
    }
    this.server.to('super-admins').emit('attendance:event', data);
  }
}
