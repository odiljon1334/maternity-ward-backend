import {
  Body, Controller, Delete, Get, Param, Post, Put, Query,
  UseGuards, UploadedFile, UseInterceptors, Res, StreamableFile,
} from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { QueryEmployeeDto } from './dto/query-employee.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';

@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeesController {
  constructor(private readonly service: EmployeesService) {}

  @Get()
  findAll(@Query() query: QueryEmployeeDto) {
    return this.service.findAll(query);
  }

  @Get('export/excel')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  async exportExcel(@Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const buffer = await this.service.exportExcel();
    const filename = `hodimlar_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }

  @Get('export/csv-template')
  async downloadCsvTemplate(@Res() res: Response) {
    const csv = this.service.getCsvTemplate();
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="hodimlar_shablon.csv"',
    });
    res.send(csv);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  create(
    @Body() dto: CreateEmployeeDto,
    @Body('username') username?: string,
    @Body('password') password?: string,
  ) {
    return this.service.create(dto, username, password);
  }

  @Put(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateEmployeeDto) {
    return this.service.update(id, dto);
  }

  @Post(':id/photo')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('photo'))
  async uploadPhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    // Save file and return URL (simplified - in production use S3/local storage)
    const photoUrl = `/uploads/${file.filename}`;
    return this.service.updatePhoto(id, photoUrl);
  }

  @Post('import/csv')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  importCsv(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new Error('Fayl yuklanmadi');
    return this.service.importCsv(file.buffer);
  }

  @Put(':id/fire')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  fire(@Param('id') id: string, @Body('firedAt') firedAt?: string) {
    return this.service.fire(id, firedAt);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
