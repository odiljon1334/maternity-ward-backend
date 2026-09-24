export class SelfCheckInDto {
  gpsLat?: number;
  gpsLng?: number;
  gpsAccuracy?: number;
  /**
   * Ilova qaysi amalni kutayotgani (ekranda ko'rsatilgan tugma). Server
   * boshqacha qaror qilsa (masalan terminal orqali allaqachon kelgan) —
   * 409 qaytadi va ilova holatni yangilaydi. Ko'r-ko'rona check-out yoki
   * ikkinchi check-in bo'lib ketmasligi uchun.
   */
  expectedAction?: 'CHECK_IN' | 'CHECK_OUT';
}
