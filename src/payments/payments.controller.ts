import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { UserRole } from '@prisma/client';

const ALLOWED = [UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN];

@Controller('payments')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Get('overview')
  @Roles(...ALLOWED)
  @RequirePermission('payments.view')
  getOverview() {
    return this.service.getOverview();
  }

  /** Ko'p oylik qarzdorlik hisoboti (FAZA 5, 1-bosqich) — ?months=6 (standart), 1-24 oralig'ida */
  @Get('debtors')
  @Roles(...ALLOWED)
  @RequirePermission('payments.view')
  getDebtors(@Query('months') months?: string) {
    return this.service.getDebtorsReport(months ? Number(months) : 6);
  }

  /** MRR/ARR va churn ko'rinishi (FAZA 5, 3-bosqich) — ?months=8 (standart), 2-24 oralig'ida */
  @Get('platform-stats')
  @Roles(...ALLOWED)
  @RequirePermission('payments.view')
  getPlatformStats(@Query('months') months?: string) {
    return this.service.getPlatformStats(months ? Number(months) : 8);
  }

  @Get()
  @Roles(...ALLOWED)
  @RequirePermission('payments.view')
  findAll(
    @Query('hospitalId') hospitalId?: string,
    @Query('period') period?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findAll({
      hospitalId,
      period,
      limit: limit ? Number(limit) : 100,
    });
  }

  @Post()
  @Roles(...ALLOWED)
  @RequirePermission('payments.edit')
  create(@Body() dto: CreatePaymentDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN)
  @RequirePermission('payments.edit')
  update(@Param('id') id: string, @Body() dto: UpdatePaymentDto) {
    return this.service.update(id, dto);
  }
  // DELETE endpoint removed intentionally — payments cannot be deleted
}
