import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TenantScopeGuard } from './guards/tenant-scope.guard';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [TenantScopeGuard],
  exports: [TenantScopeGuard],
})
export class CommonModule {}
