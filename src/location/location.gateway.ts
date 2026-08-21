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
  cors: { origin: '*' },
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
    @MessageBody() payload: { token: string },
  ) {
    try {
      const user = this.jwtService.verify(payload.token);
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
}
