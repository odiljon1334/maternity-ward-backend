import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from '../prisma/prisma.service';

/**
 * DIDOX integratsiyasi — ЭЦП (E-IMZO) orqali autentifikatsiya.
 *
 * ⚠️ MUHIM CHEKLOV (2026-09-20 holatiga ko'ra):
 * Quyidagi endpoint yo'llari va so'rov tuzilishi Didox'ning RASMIY,
 * hisobga kirishni talab qiladigan hujjatlaridan (api-docs.didox.uz) emas,
 * balki ochiq Postman namunasidan (uchinchi tomon integratori tomonidan
 * e'lon qilingan "DIDOX-1C-INTEGRATION" kolleksiyasi) olingan. U yerda faqat
 * SO'ROV formatlari ko'rsatilgan, JAVOB (response) tuzilishi ko'rsatilmagan
 * ("No response body" — namuna to'ldirilmagan edi). Shuning uchun:
 *   1. Javob parsing mantig'i (masalan `data.authId`, `data.token`) TAXMIN
 *      asosida yozilgan — haqiqiy Didox hisobi bilan sinovdan o'tkazilmaguncha
 *      ishlashi KAFOLATLANMAYDI.
 *   2. Ishlab chiqarishga chiqarishdan oldin: (a) Odiljon api-docs.didox.uz'da
 *      haqiqiy hisob ochishi, (b) shu hisobning rasmiy hujjatlari bilan pastdagi
 *      yo'llar/maydonlar solishtirib chiqilishi kerak.
 *   3. Imzolashning o'zi (pkcs7 yaratish) BIZNING SERVERIMIZDA HECH QACHON
 *      amalga oshirilmaydi — bu frontend'da, accountant kompyuterida ishlaydigan
 *      E-IMZO ID lokal agenti orqali bajariladi. Backend faqat tayyor imzolangan
 *      struktura va undan olingan tokenni qabul qiladi/saqlaydi.
 *
 * .env:
 *   DIDOX_API_BASE_URL = https://... (hali rasmiy manzil tasdiqlanmagan)
 */

interface DidoxChallengeResponse {
  authId?: string;
  [key: string]: unknown;
}

interface DidoxAuthResponse {
  token?: string;
  expiresIn?: number; // soniyalarda, taxminan (login uchun ~86400s = 24 soat)
  [key: string]: unknown;
}

@Injectable()
export class DidoxService {
  private readonly logger = new Logger(DidoxService.name);
  private readonly baseUrl: string;
  private readonly configured: boolean;
  private readonly http: AxiosInstance;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.baseUrl = this.config.get('DIDOX_API_BASE_URL', '');
    this.configured = !!this.baseUrl;

    if (!this.configured) {
      this.logger.warn(
        "DIDOX_API_BASE_URL sozlanmagan — Didox integratsiyasi ishlamaydi (StaffPulse rejasi, hali sinovdan o'tkazilmagan xususiyat).",
      );
    }

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 15_000,
    });
  }

  private assertConfigured() {
    if (!this.configured) {
      throw new BadGatewayException(
        "Didox integratsiyasi hali sozlanmagan (DIDOX_API_BASE_URL yo'q)",
      );
    }
  }

  /**
   * 1-bosqich: authId (challenge) olish — E-IMZO agenti shu qiymatni
   * mijozning ЭЦП kaliti bilan imzolab, /login'ga yuboradi.
   */
  async getChallenge(
    hospitalId: string,
    serialNumber: string,
  ): Promise<{ authId: string }> {
    this.assertConfigured();

    let authId: string;
    try {
      const res = await this.http.get<DidoxChallengeResponse>(
        `/v1/auth/authId/${encodeURIComponent(serialNumber)}`,
      );
      // Didox javobi { authId: '...' } yoki to'g'ridan-to'g'ri satr bo'lishi
      // mumkin (javob tuzilishi tasdiqlanmagan) — lekin bo'sh obyekt `{}`
      // ni HECH QACHON haqiqiy authId deb qabul qilmaslik kerak (avvalgi
      // `res.data ?? ''` varianti buni "[object Object]" ga aylantirib,
      // xatoni yashirib qo'yardi — testda topildi).
      const raw: unknown = res.data;
      authId =
        typeof raw === 'string' ? raw : String((raw as any)?.authId ?? '');
    } catch (err) {
      this.logger.error(`Didox challenge xatosi: ${(err as Error).message}`);
      throw new BadGatewayException(
        "Didox'dan challenge (authId) olib bo'lmadi",
      );
    }

    if (!authId) {
      throw new BadGatewayException('Didox javobida authId topilmadi');
    }

    await this.upsertCredential(hospitalId, serialNumber, {
      lastAuthId: authId,
    });
    return { authId };
  }

  /**
   * Yangi foydalanuvchini (yuridik shaxsni) ЭЦП kaliti orqali ro'yxatdan
   * o'tkazish. `pkcs7` — E-IMZO agenti tomonidan frontend'da imzolangan.
   */
  async register(
    hospitalId: string,
    params: {
      serialNumber: string;
      pkcs7: string;
      email: string;
      mobile: string;
      accept: string;
    },
  ): Promise<{ registered: boolean }> {
    this.assertConfigured();

    try {
      await this.http.post(
        '/v1/auth/register',
        {
          email: params.email,
          mobile: params.mobile,
          accept: params.accept,
        },
        {
          headers: {
            Authorization: `Bearer ${params.pkcs7}`,
          },
          params: { serialNumber: params.serialNumber },
        },
      );
    } catch (err) {
      this.logger.error(
        `Didox ro'yxatdan o'tkazish xatosi: ${(err as Error).message}`,
      );
      throw new BadGatewayException("Didox'da ro'yxatdan o'tkazib bo'lmadi");
    }

    await this.upsertCredential(hospitalId, params.serialNumber, {});
    return { registered: true };
  }

  /**
   * 2-bosqich: authId'ni imzolab (pkcs7) tokenga almashtirish.
   * Token ~24 soat amal qiladi, `HospitalDidoxCredential`ga saqlanadi.
   */
  async login(
    hospitalId: string,
    params: { serialNumber: string; authId: string; pkcs7: string },
  ): Promise<{ token: string; expiresAt: Date }> {
    this.assertConfigured();

    let data: DidoxAuthResponse;
    try {
      const res = await this.http.post<DidoxAuthResponse>('/v1/auth/login', {
        serialNumber: params.serialNumber,
        pkcs7: params.pkcs7,
      });
      data = res.data;
    } catch (err) {
      this.logger.error(`Didox login xatosi: ${(err as Error).message}`);
      throw new BadGatewayException("Didox'ga kirib bo'lmadi (login)");
    }

    const token = data?.token;
    if (!token) {
      throw new BadGatewayException('Didox javobida token topilmadi');
    }

    const expiresInSeconds = data?.expiresIn ?? 24 * 60 * 60; // taxminan 24 soat
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    await this.upsertCredential(hospitalId, params.serialNumber, {
      authToken: token,
      tokenExpiresAt: expiresAt,
    });

    return { token, expiresAt };
  }

  /** Shifoxonaning joriy Didox ulanish holati (token bormi, muddati o'tganmi). */
  async getStatus(hospitalId: string) {
    const cred = await this.prisma.hospitalDidoxCredential.findUnique({
      where: { hospitalId },
    });

    if (!cred) {
      return {
        connected: false,
        hasToken: false,
        serialNumber: null,
        tokenExpiresAt: null,
      };
    }

    const hasToken = !!(
      cred.authToken &&
      cred.tokenExpiresAt &&
      cred.tokenExpiresAt > new Date()
    );
    return {
      connected: true,
      hasToken,
      serialNumber: cred.serialNumber,
      tokenExpiresAt: cred.tokenExpiresAt,
    };
  }

  async disconnect(hospitalId: string) {
    const cred = await this.prisma.hospitalDidoxCredential.findUnique({
      where: { hospitalId },
    });
    if (!cred) {
      throw new NotFoundException(
        'Bu shifoxona uchun Didox ulanishi topilmadi',
      );
    }
    await this.prisma.hospitalDidoxCredential.delete({ where: { hospitalId } });
    return { disconnected: true };
  }

  private async upsertCredential(
    hospitalId: string,
    serialNumber: string,
    fields: { authToken?: string; tokenExpiresAt?: Date; lastAuthId?: string },
  ) {
    if (!hospitalId) {
      throw new BadRequestException('hospitalId aniqlanmadi');
    }
    await this.prisma.hospitalDidoxCredential.upsert({
      where: { hospitalId },
      create: { hospitalId, serialNumber, ...fields },
      update: { serialNumber, ...fields },
    });
  }
}
