/**
 * PM2 Ecosystem Config — Maternity Ward Backend
 *
 * ⚠️  DOCKER ishlatayotgan bo'lsangiz bu fayl KERAK EMAS!
 *     Docker o'zi process boshqaradi. Bu fayl faqat bare-metal
 *     (Docker'siz, to'g'ridan-to'g'ri server) deploy uchun.
 *
 * Cluster mode: barcha CPU yadrolariga HTTP requestlar taqsimlanadi.
 *
 * ⚠️  WebSocket (WsAdapter) cluster rejimida:
 *     Bir worker'da emit qilingan WS event boshqa worker'dagi
 *     clientlarga etib bormaydi. Nginx ip_hash yoki sticky modul
 *     ishlatilsa, bir foydalanuvchi har doim bitta worker'ga tushadi.
 *     Real-time notificationlar uchun kritik bo'lsa — Redis pub/sub
 *     (Socket.IO Redis adapter) qo'shing.
 *
 * Ishga tushirish:
 *   npm run build
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save
 */

const os = require('os');
const cpus = os.cpus().length;        // 32
const INSTANCES = Math.min(cpus, 8);  // max 8: DB connection pool'ni himoya qiladi
//  8 instance × 10 DB connection = 80 — PostgreSQL default 100 dan past

module.exports = {
  apps: [
    {
      name: 'maternity-backend',
      script: 'dist/src/main.js',

      // ── Cluster mode ─────────────────────────────────────────────
      instances: INSTANCES,
      exec_mode: 'cluster',

      // ── Memory / CPU ─────────────────────────────────────────────
      node_args: '--max-old-space-size=4096',   // 4 GB per worker
      max_memory_restart: '4G',                  // avtomatik restart

      // ── Restart policy ───────────────────────────────────────────
      restart_delay: 2000,
      max_restarts: 10,
      min_uptime: '10s',

      // ── Graceful shutdown (SIGINT) ────────────────────────────────
      kill_timeout: 5000,       // 5 sek kutadi, keyin SIGKILL
      listen_timeout: 8000,     // worker tayyor bo'lishini kutish

      // ── Logging ──────────────────────────────────────────────────
      combine_logs: true,
      error_file: 'logs/pm2-error.log',
      out_file:   'logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // ── Watch (production'da o'chiq bo'lsin) ─────────────────────
      watch: false,
      ignore_watch: ['node_modules', 'uploads', 'logs', 'dist'],

      // ── Environment: production ───────────────────────────────────
      env_production: {
        NODE_ENV: 'production',
        PORT: 5001,
      },

      // ── Environment: development (1 instance, fork) ───────────────
      env_development: {
        NODE_ENV: 'development',
        PORT: 5001,
        instances: 1,
        exec_mode: 'fork',
      },
    },
  ],
};
