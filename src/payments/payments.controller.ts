import {
  Controller, Get, Post, Patch, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

const ALLOWED = [UserRole.SUPER_ADMIN, UserRole.ASSISTANT_ADMIN];

@Controller('payments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Get('overview')
  @Roles(...ALLOWED)
  getOverview() {
    return this.service.getOverview();
  }

  @Get()
  @Roles(...ALLOWED)
  findAll(
    @Query('hospitalId') hospitalId?: string,
    @Query('period') period?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findAll({ hospitalId, period, limit: limit ? Number(limit) : 100 });
  }

  @Post()
  @Roles(...ALLOWED)
  create(@Body() dto: CreatePaymentDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdatePaymentDto) {
    return this.service.update(id, dto);
  }
  // DELETE endpoint removed intentionally — payments cannot be deleted
}
