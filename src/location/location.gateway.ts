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

  constructor(private readonly jwtService: JwtService) {}

  handleConnection(client: Socket) {
    console.log(`[LiveLocation] connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`[LiveLocation] disconnected: ${client.id}`);
  }

  @SubscribeMessage('join:admin')
  handleAdminJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { token?: string },
  ) {
    try {
      // Yangi browser UI HttpOnly cookie ishlatadi; eski clientlar esa
      // rollout davomida tokenni event payload'ida yuborishi mumkin.
      const cookie = client.handshake.headers.cookie ?? '';
      const cookieToken = cookie.match(/(?:^|;\s*)access_token=([^;]+)/)?.[1];
      const token = cookieToken
        ? decodeURIComponent(cookieToken)
        : payload?.token;
      if (!token) throw new Error('token_missing');
      const user = this.jwtService.verify(token);
      const adminRoles = [
        UserRole.DIRECTOR,
        UserRole.ADMIN,
        UserRole.SUPER_ADMIN,
        UserRole.DEPARTMENT_HEAD,
        UserRole.ASSISTANT_ADMIN,
        UserRole.MINISTRY,
      ];

      if (adminRoles.includes(user.role)) {
        if (
          user.role === UserRole.SUPER_ADMIN ||
          user.role === UserRole.MINISTRY
        ) {
          // SUPER_ADMIN barcha hospital room'lariga kiradi
          client.join('super-admins');
          client.emit('join:success', { room: 'super-admins' });
        } else {
          client.join(`hospital:${user.hospitalId}`);
          client.emit('join:success', { room: `hospital:${user.hospitalId}` });
        }
      } else {
        client.emit('join:error', { message: "Ruxsat yo'q" });
      }
    } catch {
      client.emit('join:error', { message: "Token noto'g'ri" });
    }
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
