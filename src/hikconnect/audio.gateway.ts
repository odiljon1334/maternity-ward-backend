import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server } from 'ws';
import * as WebSocket from 'ws';
import * as http from 'http';
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// ─── G.711 μ-law encoder (PCM Int16 → μ-law 8-bit) ─────────────────────────
const EXP_LUT = [
  0,0,1,1,2,2,2,2,3,3,3,3,3,3,3,3,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
];

function pcm16ToUlaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  const exp = EXP_LUT[(sample >> 7) & 0xFF];
  const mantissa = (sample >> (exp + 3)) & 0x0F;
  return (~(sign | (exp << 4) | mantissa)) & 0xFF;
}

function pcmBufferToUlaw(pcmInt16: Buffer): Buffer {
  const samples = pcmInt16.byteLength / 2;
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = pcm16ToUlaw(pcmInt16.readInt16LE(i * 2));
  }
  return out;
}

// ─── Digest Auth helper ──────────────────────────────────────────────────────
function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

function buildDigestAuth(
  wwwAuth: string,
  method: string,
  path: string,
  user: string,
  pass: string,
): string {
  const realm    = (wwwAuth.match(/realm="([^"]*)"/)    || [])[1] ?? '';
  const nonce    = (wwwAuth.match(/nonce="([^"]*)"/)    || [])[1] ?? '';
  const qop      = (wwwAuth.match(/qop="([^"]*)"/)      || [])[1] ?? '';
  const opaque   = (wwwAuth.match(/opaque="([^"]*)"/)   || [])[1] ?? '';

  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${path}`);

  let response: string;
  let extras = '';

  if (qop === 'auth' || qop === 'auth,auth-int') {
    const nc     = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    extras   = `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  return (
    `Digest username="${user}", realm="${realm}", nonce="${nonce}", ` +
    `uri="${path}", response="${response}"` +
    (opaque ? `, opaque="${opaque}"` : '') +
    extras
  );
}

// ─── Session record ──────────────────────────────────────────────────────────
interface AudioSession {
  req:    http.ClientRequest;
  active: boolean;
}

// ─── Gateway ─────────────────────────────────────────────────────────────────
@WebSocketGateway({
  path: '/ws/audio',
  cors: {
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(',').map((s) => s.trim())
      : ['http://localhost:3000', 'http://localhost:5000'],
    credentials: true,
  },
})
export class AudioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(AudioGateway.name);
  private sessions = new Map<WebSocket, AudioSession>();

  constructor(private readonly prisma: PrismaService) {}

  handleConnection(client: WebSocket) {
    // Binary frames (audio PCM) — NestJS @SubscribeMessage handles JSON only,
    // so we hook into the raw ws 'message' event for binary data.
    (client as any).on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) this.onAudioFrame(client, raw);
    });
  }

  handleDisconnect(client: WebSocket) {
    const session = this.sessions.get(client);
    if (session?.active) {
      try { session.req.end(); } catch {}
    }
    this.sessions.delete(client);
  }

  // ─── start-audio ──────────────────────────────────────────────────────────
  @SubscribeMessage('start-audio')
  async onStartAudio(client: WebSocket, payload: { cameraId: string }) {
    if (this.sessions.has(client)) return; // already active

    const camera = await this.prisma.camera.findUnique({
      where: { id: payload.cameraId },
    });

    if (!camera?.deviceSerial) {
      this.send(client, 'error', 'RTSP URL sozlanmagan (deviceSerial bo\'sh)');
      return;
    }

    // rtsp://user:pass@host:port/...
    const m = camera.deviceSerial.match(/^rtsp:\/\/([^:@]+):([^@]+)@([^:/]+)/i);
    if (!m) {
      this.send(client, 'error', 'RTSP URL formati noto\'g\'ri');
      return;
    }
    const [, user, pass, host] = m;

    try {
      const req = await this.openHikvisionAudio(host, user, pass);
      this.sessions.set(client, { req, active: true });
      this.send(client, 'audio-started', null);
      this.logger.log(`Audio session: ${host} (camera ${camera.name})`);
    } catch (err: any) {
      this.send(client, 'error', err.message);
      this.logger.error(`Audio session ochilmadi: ${err.message}`);
    }
  }

  // ─── stop-audio ───────────────────────────────────────────────────────────
  @SubscribeMessage('stop-audio')
  onStopAudio(client: WebSocket) {
    const session = this.sessions.get(client);
    if (session?.active) {
      try { session.req.end(); } catch {}
      session.active = false;
    }
    this.sessions.delete(client);
    this.send(client, 'audio-stopped', null);
  }

  // ─── Binary PCM frame ─────────────────────────────────────────────────────
  private onAudioFrame(client: WebSocket, buf: Buffer) {
    const session = this.sessions.get(client);
    if (!session?.active) return;
    const ulaw = pcmBufferToUlaw(buf);
    try {
      session.req.write(ulaw);
    } catch {
      session.active = false;
    }
  }

  // ─── Open Hikvision two-way audio (HTTP chunked, Digest auth) ─────────────
  private openHikvisionAudio(
    host: string,
    user: string,
    pass: string,
  ): Promise<http.ClientRequest> {
    const path   = '/ISAPI/Streaming/channels/101/httpTwoWayAudio';
    const method = 'PUT';

    return new Promise((resolve, reject) => {
      // Step 1: probe to get Digest challenge
      const probe = http.request(
        { hostname: host, port: 80, path, method, timeout: 5000 },
        (res) => {
          res.resume(); // drain
          if (res.statusCode === 401) {
            const wwwAuth = res.headers['www-authenticate'] || '';
            const auth    = buildDigestAuth(wwwAuth, method, path, user, pass);

            // Step 2: real request with auth, keep-alive body stream
            const req = http.request({
              hostname: host,
              port:     80,
              path,
              method,
              headers: {
                Authorization:     auth,
                'Content-Type':    'application/octet-stream',
                'Transfer-Encoding': 'chunked',
              },
            });
            req.on('error', (e) => this.logger.warn(`Hikvision audio req err: ${e.message}`));
            req.on('response', (r) => {
              r.resume();
              if (r.statusCode && r.statusCode >= 400) {
                this.logger.warn(`Hikvision audio HTTP ${r.statusCode}`);
              }
            });
            resolve(req);
          } else if (res.statusCode === 200 || res.statusCode === 204) {
            // Device accepts without auth (shouldn't happen but handle it)
            const req = http.request({
              hostname: host, port: 80, path, method,
              headers: {
                'Content-Type': 'application/octet-stream',
                'Transfer-Encoding': 'chunked',
              },
            });
            resolve(req);
          } else {
            reject(new Error(`Terminal ${res.statusCode} qaytardi. Two-way audio qo'llab-quvvatlanmasligi mumkin.`));
          }
        },
      );
      probe.on('error', (e) => reject(new Error(`Terminal ulanmadi: ${e.message}`)));
      probe.on('timeout', () => { probe.destroy(); reject(new Error('Terminal timeout (5s)')); });
      probe.end();
    });
  }

  private send(client: WebSocket, event: string, data: any) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event, data }));
    }
  }
}
