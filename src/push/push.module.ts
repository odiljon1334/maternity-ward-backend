import { Module, Global } from '@nestjs/common';
import { PushService } from './push.service';
import { PushController } from './push.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Global() // Global: boshqa modullar import qilmasdan ishlatadi
@Module({
  imports: [NotificationsModule],
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
