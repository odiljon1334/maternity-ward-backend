import { IsOptional, IsString } from 'class-validator';
import { CreateShiftDto } from './create-shift.dto';

export class ResolveShiftDto extends CreateShiftDto {
  /**
   * Grafik kimga yaratilayotgani.
   *
   * Kasalxonani aniqlashda eng ishonchli manba — xodimning o'zi.
   * JWT dagi hospitalId SUPER_ADMIN uchun null bo'ladi, `targetHospitalId`
   * esa UI da kasalxona tanlanmagan bo'lsa yuborilmaydi. Shu sabab
   * ikkalasi ham bo'lmasa, xodim orqali topamiz.
   */
  @IsOptional()
  @IsString()
  employeeId?: string;
}
