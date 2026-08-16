export const TIMEZONE = process.env.TIMEZONE || 'Asia/Tashkent';
export const LATE_GRACE_MINUTES = parseInt(
  process.env.LATE_GRACE_PERIOD_MIN || '15',
  10,
);
export const WEEKLY_LATE_THRESHOLD_MIN = parseInt(
  process.env.WEEKLY_LATE_PENALTY_THRESHOLD_MIN || '120',
  10,
);
export const OVERTIME_RATE = parseFloat(process.env.OVERTIME_RATE || '1.5');
export const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
