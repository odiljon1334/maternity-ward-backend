/**
 * So'rov qaysi muassasa doirasida bajarilishini aniqlaydi.
 *
 * JWT'dagi muassasa har doim ustun: tenant rollari (ADMIN, DIRECTOR,
 * DEPARTMENT_HEAD, EMPLOYEE) muassasasiz bo'lsa JwtAuthGuard ularni rad
 * etadi, ASSISTANT_ADMIN uchun esa TenantScopeGuard `hospitalId`ni
 * tasdiqlangan qiymatga almashtiradi. Shuning uchun `targetHospitalId`
 * faqat platforma rollari (SUPER_ADMIN) uchun amalda ishlaydi.
 */
export function resolveHospitalId(
  jwtHospitalId: string | null | undefined,
  targetHospitalId?: string,
): string | null {
  return jwtHospitalId || targetHospitalId || null;
}
