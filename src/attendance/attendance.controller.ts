import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AttendanceService } from './attendance.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { SelfCheckInDto } from './dto/self-check-in.dto';

@Controller('attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendanceController {
  constructor(private readonly service: AttendanceService) {}

  @Get('daily')
  getDailyAttendance(
    @CurrentUser('hospitalId') jwtHospitalId: string | null,
    @Query('date') date?: string,
    @Query('departmentId') departmentId?: string,
    @Query('targetHospitalId') targetHospitalId?: string,
  ) {
    const hospitalId = targetHospitalId || jwtHospitalId || undefined;
    return this.service.getDailyAttendance(
      date || new Date().toISOString().slice(0, 10),
      departmentId,
      hospitalId,
    );
  }

  @Get('my')
  getMyAttendance(
    @CurrentUser('sub') userId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    return this.service.getMyAttendance(
      userId,
      +month || new Date().getMonth() + 1,
      +year || new Date().getFullYear(),
    );
  }

  @Get('employee/:id')
  getEmployeeAttendance(
    @Param('id') id: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    return this.service.getEmployeeAttendance(
      id,
      +month || new Date().getMonth() + 1,
      +year || new Date().getFullYear(),
    );
  }

  @Get('weekly-stats/:employeeId')
  getWeeklyStats(
    @Param('employeeId') employeeId: string,
    @Query('weekStart') weekStart: string,
  ) {
    return this.service.getWeeklyStats(employeeId, weekStart);
  }

  /**
   * EMPLOYEE o'zi GPS + selfie bilan davomat belgilaydi.
   * multipart/form-data: selfie (optional) + JSON maydonlar.
   */
  @Post('self-checkin')
  @Roles(UserRole.EMPLOYEE)
  @UseInterceptors(FileInterceptor('selfie', { storage: memoryStorage() }))
  selfCheckIn(
    @CurrentUser('sub') userId: string,
    @Body('gpsLat') gpsLat?: string,
    @Body('gpsLng') gpsLng?: string,
    @Body('gpsAccuracy') gpsAccuracy?: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const dto = new SelfCheckInDto();
    if (gpsLat) dto.gpsLat = parseFloat(gpsLat);
    if (gpsLng) dto.gpsLng = parseFloat(gpsLng);
    if (gpsAccuracy) dto.gpsAccuracy = parseFloat(gpsAccuracy);
    return this.service.selfCheckIn(userId, dto, file?.buffer);
  }

  /**
   * Xodim birinchi marta ish joyi GPS ni o'rnatadi (Hospital.gpsLat/gpsLng).
   * Faqat hospital GPS null bo'lsa saqlanadi.
   */
  @Post('set-hospital-gps')
  @Roles(UserRole.EMPLOYEE)
  setHospitalGps(
    @CurrentUser('sub') userId: string,
    @Body('lat') lat: string,
    @Body('lng') lng: string,
  ) {
    return this.service.setHospitalGps(
      userId,
      parseFloat(lat),
      parseFloat(lng),
    );
  }

  @Post('set-employee-gps')
  @Roles(UserRole.EMPLOYEE)
  setEmployeeGps(
    @CurrentUser('sub') userId: string,
    @Body('lat') lat: string,
    @Body('lng') lng: string,
  ) {
    return this.service.setEmployeeGps(
      userId,
      parseFloat(lat),
      parseFloat(lng),
    );
  }

  @Post('manual-checkin')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.DIRECTOR)
  manualCheckIn(
    @Body() body: { employeeId: string; checkInTime: string; note?: string },
  ) {
    return this.service.manualCheckIn(
      body.employeeId,
      body.checkInTime,
      body.note,
    );
  }

  @Post('mark-absent')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  markAbsent() {
    return this.service.markAbsentForToday();
  }
}
