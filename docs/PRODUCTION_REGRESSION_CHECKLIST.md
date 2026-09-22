# MaternityCare production regression checklist

Ushbu ro'yxat har bir production deploydan keyin bajariladi. Asosiy maqsad —
terminal webhooklarini uzmasdan auth, frontend, Face Match, Telegram, email va
push oqimlarining ishlayotganini qisqa va takrorlanadigan tarzda tasdiqlash.

## 1. Deploydan oldin

- Backend va frontend `main` branch holati toza ekanini tekshiring.
- Backend: `npm test -- --runInBand` va `npm run build`.
- Frontend: `npx tsc --noEmit`, target ESLint va `npm run build`.
- `.env.prod` qiymatlarini ekranga chiqarmang. Faqat kerakli kalitlarning
  mavjudligini `test -n` bilan tekshiring.
- Production deploy uchun faqat backend repo ichidagi `bash deploy.sh`dan
  foydalaning. Alohida eski compose/deploy skriptlari qo'llanilmaydi.

## 2. Deploy

```bash
cd /home/maternit-backend/maternity-ward-backend
bash deploy.sh
```

Deploy quyidagilarni o'zi tekshiradi: Nginx sintaksisi, image build, Prisma
migration, Face Match readiness, backend rolling deploy, frontend health va
Nginx graceful reload. Jarayon davomida Nginx/Postgres/Redis to'xtatilmaydi;
eski healthy backend yangi backend tayyor bo'lguncha webhooklarni qabul qiladi.

## 3. Majburiy smoke test

### Servislar

```bash
docker compose -f docker-compose.production.yml --env-file .env.prod ps
curl -fsS https://api.clinicuk24.com/api/v1/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://clinicuk24.com/login
```

Kutiladi: application containerlari `healthy`, API `status: ok`, login `200`.

### Terminal webhook

```bash
docker compose -f docker-compose.production.yml --env-file .env.prod \
  logs --since=10m backend | grep -E 'HikvisionWebhookController|AttendanceService'
```

- Heartbeatlar qabul qilinishi normal; ularda `employeeNo` bo'lmaydi.
- Haqiqiy yuz hodisasida `employeeNo`, vaqt va device aniqlanishi kerak.
- Webhook uchun 401/403, container restart loop yoki uzilish bo'lmasligi kerak.

### Login va parol tiklash

- Login qiling; `/dashboard` ochilib, qayta `/login`ga qaytmasin.
- `POST /auth/profile` yoki profil so'rovi `200` qaytarsin.
- `Parolni unutdingizmi?` orqali test hisobiga reset xati yuboring.
- Resend xati kelishi, link bir marta ishlashi va eski parol rad etilishini
  tekshiring. Production foydalanuvchisining parolini sinov uchun o'zgartirmang.

### Face Match

- `face-match` containeri `healthy` bo'lsin.
- Mobil check-in vaqtida tekshiruv animatsiyasi, muvaffaqiyat yoki tushunarli
  rad javobi ko'rinsin; sahifa abadiy loadingda qolmasin.

### Telegram botlar

- HR botga `/start` yuboring va asosiy menyu chiqishini tekshiring.
- SupportBotga oddiy savol yuboring: javob rasmiy `siz` shaklida bo'lsin.
- SupportBotga `/trial` yuboring; lead `/panel/leads`da paydo bo'lsin va
  operatorga username/chat havolasi bilan xabar borsin.
- Backend logida `Support bot commands/About metadata yangilandi` yozuvi
  ko'rinishi kerak.

### Mobil PWA push

1. iPhone/iPad: saytni Safari orqali Home Screen'ga qo'shing va aynan o'sha
   ikonka orqali oching. Chrome/Edge desktopda o'rnatilgan PWA ham ishlaydi.
2. `/dashboard/settings`da `Push xabarnomalar`ni yoqing.
3. Super Admin sessiyasida brauzer Console orqali test yuboring:

```js
fetch('https://api.clinicuk24.com/api/v1/push/test', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: 'StaffPlusPRO test',
    body: 'Push xabarnoma muvaffaqiyatli ishladi',
  }),
})
```

4. Ilovani fon holatiga o'tkazing. Xabar kelishi va ustiga bosilganda
   `/dashboard` ochilishini tekshiring.

## 4. SupportBot profili — bir martalik amal

About, qisqa tavsif va `/start`/`/trial` buyruqlari backend tomonidan har
deployda avtomatik o'rnatiladi. Telegram Bot API profil rasmini o'zgartirishga
ruxsat bermaydi; uni BotFather orqali bir marta qo'yish kerak:

```bash
bash scripts/setup-support-bot-profile.sh
```

Wizard ishlatadigan logo:
`/home/maternit-backend/maternity-ward-frontend/public/icons/staffpluspro-supportbot.png`.

## 5. Yakunlash mezoni

- Yuqoridagi barcha smoke testlar o'tdi.
- Sentry'da deploydan keyin yangi 5xx regressiya yo'q.
- Terminal webhook eventlari uzluksiz kelmoqda.
- O'zgartirish commitlari va productionda turgan commit SHA yozib qo'yildi.
- Muammo bo'lsa yangi deployni davom ettirmang; `deploy.sh` logi va Sentry
  hodisasi bilan sababni aniqlang. Deploy health check muvaffaqiyatsiz bo'lsa,
  skript application image'ini avtomatik rollback qiladi.
