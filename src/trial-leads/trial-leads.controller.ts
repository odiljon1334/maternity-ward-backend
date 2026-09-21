import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { QueryTrialLeadsDto } from './dto/query-trial-leads.dto';
import { UpdateTrialLeadDto } from './dto/update-trial-lead.dto';
import { TrialLeadsService } from './trial-leads.service';

@Controller('trial-leads')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class TrialLeadsController {
  constructor(
    private readonly trialLeads: TrialLeadsService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  findAll(@Query() query: QueryTrialLeadsDto) {
    return this.trialLeads.findAll(query);
  }

  @Get('stats')
  getStats() {
    return this.trialLeads.getStats();
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateTrialLeadDto,
    @CurrentUser('sub') actorId: string,
  ) {
    const result = await this.trialLeads.updateStatus(id, dto.status, dto.note);
    this.auditLog.log({
      userId: actorId,
      action: 'UPDATE',
      entity: 'TrialLead',
      entityId: id,
      details: { status: dto.status },
    });
    return result;
  }
}
