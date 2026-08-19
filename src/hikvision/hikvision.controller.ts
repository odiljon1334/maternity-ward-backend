import {
  Controller,
  Post,
  Delete,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseInterceptors,
  UploadedFile,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { HikvisionService } from './hikvision.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AddPersonDto } from './hikvision.dto';

@UseGuards(JwtAuthGuard)
@Controller('hikvision')
export class HikvisionController {
  constructor(private readonly hikvision: HikvisionService) {}

  // Gateway devices
  @Get('devices')
  getDevices() {
    return this.hikvision.getDevices();
  }

  // Person
  @Post('devices/:devIndex/persons')
  addPerson(@Param('devIndex') devIndex: string, @Body() dto: AddPersonDto) {
    return this.hikvision.addPerson(devIndex, dto);
  }

  @Delete('devices/:devIndex/persons/:employeeNo')
  deletePerson(
    @Param('devIndex') devIndex: string,
    @Param('employeeNo') employeeNo: string,
  ) {
    return this.hikvision.deletePerson(devIndex, employeeNo);
  }

  // Face
  @Post('devices/:devIndex/persons/:employeeNo/face')
  @UseInterceptors(FileInterceptor('image'))
  addFace(
    @Param('devIndex') devIndex: string,
    @Param('employeeNo') employeeNo: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.hikvision.addFacePicture(
      devIndex,
      employeeNo,
      file.buffer,
      file.mimetype,
    );
  }

  @Delete('devices/:devIndex/persons/:employeeNo/face')
  deleteFace(
    @Param('devIndex') devIndex: string,
    @Param('employeeNo') employeeNo: string,
  ) {
    return this.hikvision.deleteFacePicture(devIndex, employeeNo);
  }

  @Get('terminals')
  getTerminals(@Query('hospitalId') hospitalId: string) {
    if (hospitalId === 'all') {
      return this.hikvision.getAllTerminalsWithStatus();
    }
    return this.hikvision.getTerminalsWithStatus(hospitalId);
  }

  @Post('terminals')
  addTerminal(
    @Body()
    body: {
      hospitalId: string;
      name: string;
      devIndex: string;
      password?: string;
    },
  ) {
    return this.hikvision.addTerminal(body.hospitalId, {
      name: body.name,
      devIndex: body.devIndex,
      password: body.password,
    });
  }

  @Delete('terminals/:id')
  deleteTerminal(
    @Param('id') id: string,
    @Query('hospitalId') hospitalId: string,
  ) {
    return this.hikvision.removeTerminal(id, hospitalId);
  }

  @Patch('terminals/:id')
  toggleTerminal(
    @Param('id') id: string,
    @Body() body: { isActive: boolean; hospitalId: string },
  ) {
    return this.hikvision.toggleTerminal(id, body.hospitalId, body.isActive);
  }

  // Bulk sync
  @Post('sync/:hospitalId')
  syncHospital(@Param('hospitalId') hospitalId: string) {
    return this.hikvision.syncHospital(hospitalId);
  }
}
