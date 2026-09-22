export const TIMEZONE = process.env.TIMEZONE || 'Asia/Tashkent';
export const LATE_GRACE_MINUTES = parseInt(
  process.env.LATE_GRACE_PERIOD_MIN || '15',
  10,
);
export const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
