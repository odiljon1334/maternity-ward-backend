import {
  Body, Controller, Delete, Get, Param, Post, Put, Query,
  UseGuards, UploadedFile, UseInterceptors, Res, StreamableFile,
  Req,
} from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { QueryEmployeeDto } from './dto/query-employee.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import { AuditLogService } from '../audit-log/audit-log.service';

/** SUPER_ADMIN uchun: JWT'dagi hospitalId null bo'lsa, query'dan targetHospitalId oladi.
 *  Ikkalasi ham yo'q bo'lsa — '' qaytaradi (findAll unda filtersiz ko'rsatadi) */
function resolveHospitalId(jwtHospId: string | null, targetHospId?: string): string {
  return jwtHospId || targetHospId || '';
}

@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeesController {
  constructor(
    private readonly service: EmployeesService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  findAll(
    @Query() query: QueryEmployeeDto,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.findAll(query, resolveHospitalId(hospitalId, targetHospitalId));
  }

  @Get('export/excel')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  async exportExcel(
    @Res({ passthrough: true }) res: Response,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ): Promise<StreamableFile> {
    const hId = resolveHospitalId(hospitalId, targetHospitalId);
    const buffer = await this.service.exportExcel(hId);
    const filename = `hodimlar_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }

  @Get('export/csv-template')
  async downloadCsvTemplate(@Res() res: Response) {
    const csvData = this.service.getCsvTemplate();
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="hodimlar_shablon.csv"',
    });
    res.send(csvData);
  }

  @Get('export/enroll-pic')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  async enrollPicZip(
    @Res({ passthrough: true }) res: Response,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ): Promise<StreamableFile> {
    const hId = resolveHospitalId(hospitalId, targetHospitalId);
    const buffer = await this.service.enrollPicZip(hId);
    const filename = `enroll_pic_${new Date().toISOString().slice(0, 10)}.zip`;
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }

  @Get('archive')
  async getArchive(
    @Query('page')   page:   string,
    @Query('limit')  limit:  string,
    @Query('search') search: string,
    @Req() req: any,
  ) {
    const hospitalId = req.user.hospitalId ?? '';
    const result = await this.service.getArchive(hospitalId, {
      search: search || undefined,
      page:  page  ? +page  : 1,
      limit: limit ? +limit : 20,
    });
    return { success: true, data: result.data, meta: result.meta };
  }
  
  @Get('archive/:id')
  async getArchivedEmployee(@Param('id') id: string) {
    const result = await this.service.getArchivedEmployee(id);
    return { success: true, data: result };
  }
  
  @Get('lookup')
  async lookup(
    @Query('phone') phone: string,
    @Req() req: any,
  ) {
    const hospitalId = req.user.hospitalId ?? '';
    const result = await this.service.lookupByPhone(phone, hospitalId);
    return { success: true, data: result };
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.findOne(id, resolveHospitalId(hospitalId, targetHospitalId));
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  async create(
    @Body() dto: CreateEmployeeDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
    @Body('username') username?: string,
    @Body('password') password?: string,
  ) {
    const hId = resolveHospitalId(hospitalId, targetHospitalId);
    const result = await this.service.create(dto, hId, username, password);
    this.auditLog.log({
      userId,
      hospitalId: hId,
      action: 'CREATE',
      entity: 'Employee',
      entityId: result?.id,
      details: { fullName: dto.fullName },
    });
    return result;
  }

  @Put(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const hId = resolveHospitalId(hospitalId, targetHospitalId);
    const result = await this.service.update(id, dto, hId);
    this.auditLog.log({
      userId,
      hospitalId: hId,
      action: 'UPDATE',
      entity: 'Employee',
      entityId: id,
    });
    return result;
  }

  @Post(':id/photo')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  @UseInterceptors(FileInterceptor('photo', { storage: memoryStorage() }))
  async uploadPhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    if (!file) throw new BadRequestException('Rasm yuklanmadi');
    const hId = resolveHospitalId(hospitalId, targetHospitalId);
    const result = await this.service.updatePhoto(id, file.buffer, hId);
    this.auditLog.log({ userId, hospitalId: hId, action: 'UPDATE_PHOTO', entity: 'Employee', entityId: id });
    return result;
  }

  @Post('import/csv')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async importCsv(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    if (!file) throw new Error('Fayl yuklanmadi');
    const hId = resolveHospitalId(hospitalId, targetHospitalId);
    const result = await this.service.importCsv(file.buffer, hId);
    this.auditLog.log({
      userId,
      hospitalId: hId,
      action: 'IMPORT_CSV',
      entity: 'Employee',
      details: { imported: result?.imported, filename: file.originalname },
    });
    return result;
  }

  @Put(':id/fire')
async fire(
  @Param('id') id: string,
  @CurrentUser('sub') userId: string,
  @CurrentUser('hospitalId') hospitalId: string,
  @Query('targetHospitalId') targetHospitalId?: string,
  @Body('firedAt')     firedAt?:     string,
  @Body('fireReason')  fireReason?:  string,  // ← qo'shilmagan!
  @Body('fireNote')    fireNote?:    string,   // ← qo'shilmagan!
) {
  const hId = resolveHospitalId(hospitalId, targetHospitalId);
  const result = await this.service.fire(id, hId, firedAt, fireReason, fireNote);
  this.auditLog.log({
    userId,
    hospitalId: hId,
    action: 'FIRE',
    entity: 'Employee',
    entityId: id,
    details: { firedAt, fireReason },
  });
  return result;
}

  @Post('bulk-delete')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async bulkDelete(
    @Body('ids') ids: string[],
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const hId = resolveHospitalId(hospitalId, targetHospitalId);
    const result = await this.service.bulkDelete(ids, hId);
    this.auditLog.log({ userId, hospitalId: hId, action: 'BULK_DELETE', entity: 'Employee', details: { count: ids.length } });
    return result;
  }

  @Put('bulk-department')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  async bulkUpdateDepartment(
    @Body('ids') ids: string[],
    @Body('departmentId') departmentId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const hId = resolveHospitalId(hospitalId, targetHospitalId);
    const result = await this.service.bulkUpdateDepartment(ids, departmentId, hId);
    this.auditLog.log({ userId, hospitalId: hId, action: 'BULK_MOVE_DEPT', entity: 'Employee', details: { count: ids.length, departmentId } });
    return result;
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async remove(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const hId = resolveHospitalId(hospitalId, targetHospitalId);
    const result = await this.service.remove(id, hId);
    this.auditLog.log({
      userId,
      hospitalId: hId,
      action: 'DELETE',
      entity: 'Employee',
      entityId: id,
    });
    return result;
  }

  /** EMP-XXXXXX formatli eski employee numberlarni raqamli formatga o'tkazish */
  @Post('fix-employee-numbers')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  fixEmployeeNumbers(
    @CurrentUser('hospitalId') hospitalId: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    return this.service.fixLegacyEmployeeNumbers(resolveHospitalId(hospitalId, targetHospitalId));
  }
}
