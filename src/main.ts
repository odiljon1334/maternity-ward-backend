/* eslint-disable @typescript-eslint/no-require-imports */
// Node.js 18 da global.crypto yo'q — @nestjs/schedule v6 uchun polyfill
if (!global.crypto) {
  (global as any).crypto = require('crypto').webcrypto;
}

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import compression from 'compression';
import helmet from 'helmet';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';

async function bootstrap() {
  // bodyParser: false — raw body o'qish uchun (Hikvision multipart)
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
    bodyParser: false,
  });

  // Security headers
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // uploads uchun
      contentSecurityPolicy: false, // API server uchun kerak emas
    }),
  );

  // WebSocket adapter (same port as HTTP)
  app.useWebSocketAdapter(new WsAdapter(app));

  // CORS — production da FRONTEND_URL majburiy
  const allowedOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map((s) => s.trim())
    : ['http://localhost:3000', 'http://localhost:5000'];

  app.enableCors({
    origin: (origin, callback) => {
      // server-to-server (Postman, curl) — origin yo'q, ruxsat
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: ${origin} ruxsatsiz`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Global prefix
  app.setGlobalPrefix('api/v1');

  // Compression
  app.use(compression());

  // ✅ Hikvision webhook — raw Buffer (multipart/form-data, xml, json)
  app.use(
    /^\/(api\/v1\/hikvision\/webhook|hikvision\/webhook)/,
    express.raw({ type: '*/*', limit: '25mb' }),
  );

  // JSON + urlencoded — barcha boshqa routelar uchun
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Static files (uploaded photos)
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global filters
  app.useGlobalFilters(new AllExceptionsFilter());

  // Global interceptors
  app.useGlobalInterceptors(new ResponseInterceptor());

  const port = process.env.PORT || 5001;
  await app.listen(port);

  // Cluster worker ID (PM2 rejimida)
  const workerId = process.env.NODE_APP_INSTANCE
    ? `[Worker #${process.env.NODE_APP_INSTANCE}] `
    : '';

  console.log(`\n🏥 ${workerId}Maternity Ward Attendance API`);
  console.log(
    `🚀 ${workerId}Server running on: http://localhost:${port}/api/v1`,
  );
  console.log(`❤️  Health check: http://localhost:${port}/api/v1/health`);
  console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🧠 Memory limit: ${process.env.NODE_OPTIONS || 'default'}\n`);

  // ── Graceful shutdown (PM2 SIGINT / SIGTERM) ──────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n${workerId}${signal} qabul qilindi — graceful shutdown...`);
    await app.close();
    console.log(`${workerId}Server to'xtatildi`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Global unhandled rejection handler
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled Rejection:', reason);
  // Production da process ni o'ldirmaymiz — PM2 restart qilsin
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  process.exit(1);
});

bootstrap();
