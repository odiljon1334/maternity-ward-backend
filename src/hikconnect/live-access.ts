import { timingSafeEqual } from 'crypto';
import { isIP } from 'net';

/** Docker/ichki tarmoq manzillari (nginx, MediaMTX HLS muxer, localhost) */
export function isPrivateIp(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const ip = raw.replace(/^::ffff:/, '').trim();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(ip) === 6) {
    const low = ip.toLowerCase();
    return low === '::1' || low.startsWith('fc') || low.startsWith('fd');
  }
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type MediaMtxAuthRequest = {
  action?: string;
  user?: string;
  password?: string;
  ip?: string;
  path?: string;
  protocol?: string;
};

/**
 * MediaMTX `authMethod: http` qarori.
 *
 * - publish: MEDIAMTX_PUBLISH_PASS o'rnatilgan bo'lsa login/parol shart;
 *   o'rnatilmagan bo'lsa — eski xulq (agent'lar loginsiz yuboradi).
 * - read/playback: faqat ichki tarmoqdan (nginx orqali /live/ — u yerda
 *   foydalanuvchi sessiyasi alohida tekshiriladi). Internetdan to'g'ridan-
 *   to'g'ri RTSP/HLS o'qish yopiq; MEDIAMTX_ALLOW_PUBLIC_READ=true — eski xulq.
 * - api/metrics/pprof va boshqalar — rad.
 */
export function decideMediaMtxAccess(
  req: MediaMtxAuthRequest,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (req.action === 'publish') {
    const pass = env.MEDIAMTX_PUBLISH_PASS ?? '';
    if (!pass) return true;
    const user = env.MEDIAMTX_PUBLISH_USER || 'publisher';
    return (
      safeEqual(req.user ?? '', user) && safeEqual(req.password ?? '', pass)
    );
  }
  if (req.action === 'read' || req.action === 'playback') {
    return isPrivateIp(req.ip) || env.MEDIAMTX_ALLOW_PUBLIC_READ === 'true';
  }
  return false;
}

/**
 * `/live/<streamPath>/index.m3u8` (yoki segment) manzilidan kamera
 * `streamPath` bo'lishi mumkin bo'lgan prefikslarni qaytaradi:
 * "/live/h1/cam1/seg.mp4" → ["h1", "h1/cam1", "h1/cam1/seg.mp4"].
 */
export function streamPathCandidates(
  originalUri: string | undefined,
): string[] {
  if (!originalUri) return [];
  const pathOnly = originalUri.split('?')[0];
  if (!pathOnly.startsWith('/live/')) return [];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly.slice('/live/'.length));
  } catch {
    return [];
  }
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) return [];
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}
