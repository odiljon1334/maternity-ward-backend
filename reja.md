# StaffPlusPRO — qolgan ishlar rejasi

**Yangilangan sana:** 2026-09-28  
**Backend bazasi:** `4ebcc1b`  
**Frontend bazasi:** `81e915b`

Bu faylda faqat hali yopilmagan ishlar turadi. Bajarilgan ishlar bu rejaga
qayta qo'shilmaydi; ularning tarixi Git commitlari va production release
yozuvlarida saqlanadi.

## Ishlash qoidasi

Har bir bosqich alohida yakunlanadi:

1. kod va migratsiya;
2. unit/integration testlar hamda production build;
3. `main`ga commit va push;
4. `bash deploy.sh` orqali uzilishsiz deploy;
5. production smoke-test va ishlayotgan commit SHA'larini qayd etish.

Terminal webhooklari yangi backend tayyor bo'lguncha eski healthy backendda
qabul qilinishda davom etishi shart.

## 1. Release bloklovchi regressiyalar

1. Productiondagi barcha muassasalar uchun GPS markazi/ish joylari inventarini
   olish. Shundan keyin markazi yo'q muassasada mobil check-in'ni jim
   o'tkazib yuborishni bekor qilish va tushunarli xabar bilan bloklash.
2. Tasdiqlangan “kechikaman” izohida faqat so'ralgan `delayMinutes`gacha bo'lgan
   qismni uzrli qilish; ortiqcha kechikish haqiqiy kechikish bo'lib qolishi kerak.
3. `excusedLateMin`ni oylik/haftalik hisobot, Excel, dashboard va Telegram
   agregatlarida bir xil qo'llash; payroll bilan hisobot bir-biriga zid bo'lmasin.
4. Kechikish izohini tasdiqlash va attendance yozuvini yangilashni bitta
   tranzaksiyaga olish; yarim bajarilgan `APPROVED` holat qolmasin.
5. Avans limitini parallel so'rov bilan oshirib yuborishni DB transaction/lock
   yoki ekvivalent atomik nazorat bilan yopish.
6. Telegram check-in/check-out reminder logini faqat muvaffaqiyatli yuborilgach
   yakunlash; yuborish muvaffaqiyatsiz bo'lsa keyingi cron qayta urinishi kerak.
7. Smena almashish so'rovlarida 31 kunlik chegarani faqat ro'yxatda emas,
   create/review API darajasida ham qat'iy tekshirish.
8. 2-TUG `POST_COVERAGE` grafigida kasallik/ta'til/o'rin bosish va smena
   almashish workflowini qo'llash; hozirgi servis bu rejimni rad etadi.

**Yakun mezoni:** regressiya testlari yozilgan, backend test/build va frontend
typecheck/build toza, boshqa tenant ma'lumotiga o'tish imkonsiz.

## 2. So'nggi versiyani productionda qabul qilish

1. VPS'dagi backend va frontend SHA'larini yuqoridagi bazalar bilan solishtirish.
2. Farq bo'lsa `bash deploy.sh` bilan deploy qilish va barcha yangi
   migratsiyalar qo'llanganini tasdiqlash.
3. Majburiy smoke-test:
   - login/profile va parol tiklash;
   - xodim mobil login/refresh va muddati tugagan token holati;
   - Hikvision webhook hamda background terminal sync;
   - mobil check-in/check-out, GPS, selfie va Face Match deferred recheck;
   - ish joylari, asosiy bino GPS'i va Assistant Admin tenant chegarasi;
   - Telegram HR bot ulanishi va to'lov invoysi;
   - Sentry'da yangi 5xx yoki PII sizishi yo'qligi.
4. Productionda ishlayotgan backend/frontend SHA'larini release yozuviga kiritish.

**Yakun mezoni:** smoke-testlarning barchasi o'tgan va webhooklarda uzilish yo'q.

## 3. Haqiqiy grafik, davomat va payroll qabul sinovi

1. 2-TUG uchun bitta to'liq oylik 24/7 post grafikni haqiqiy xodimlar bilan
   yaratish: 3/6/12 soatlik smenalar, 20:00–08:00 tungi smena, kunlar bo'yicha
   4+8 soat taqsimoti va 720/744 soatlik post normasi.
2. Grafikni tasdiqlash, sababli amendment, kasallik/ta'til, bir tomonlama
   o'rnini bosish va ikki tomonlama smena almashishni tekshirish.
3. Grafik Excel eksportini qog'oz namunasi bilan satrma-satr solishtirish.
4. Shu oy bo'yicha attendance va payrollni audit qilish: kelgan/kelmagan/kech
   qolgan kunlar, erta ketish, overtime, jami ish soati, ta'til/kasallik,
   KPI/bonus, qonuniy jarima, avans, carry-over va yakuniy maosh.
5. Sinov faqat tanlangan muassasaga ta'sir qilganini boshqa production
   tenantlari bilan solishtirib tasdiqlash.

**Yakun mezoni:** Director tasdiqlagan grafik, tabel, payroll va Excel natijalari
bir-biriga mos; boshqa muassasa ma'lumoti o'zgarmagan.

## 4. iOS va Android uchun ishonchli background GPS

Hozirgi PWA `watchPosition` brauzer sahifasi tirik va operatsion tizim unga vaqt
berganda ishlaydi. iOS/Android ilovani fon rejimida muzlatishi yoki yopishi
mumkin; shu sabab bu yechim butun smena davomida kafolatli kuzatuv emas.

1. Android APK tarqatish sahifasi tayyor, ammo ilovaning haqiqiy background
   location qobiliyatini audit qilish; iOS uchun native/Capacitor yo'lini tanlash.
2. Native yo'l tanlansa: `while-in-use`/background permission oqimi, yurak urishi,
   battery-aware interval, offline queue va qayta yuborish qo'shish.
3. Director uchun `ONLINE`, `SIGNAL_LOST`, `OUTSIDE` holatlarini alohida
   ko'rsatish; bitta noto'g'ri GPS sakrashini “ish joyidan ketdi” deb olmaslik.
4. Haqiqiy iPhone va Android qurilmasida ekran o'chiq, ilova fon rejimida va
   internet uzilib-qaytgan holatlarni sinash.

**Yakun mezoni:** tanlangan mahsulot siyosati UI'da aniq, ogohlantirishlar yolg'on
musbat bermaydi va native variant tanlansa smena davomida qayta tiklanadi.

## 5. UI/UX design systemni yakunlash

1. Qolgan dashboard/panel sahifalaridagi xom `input`, `select`, `textarea`,
   tugma, modal va jadvallarni `components/ui` komponentlariga bosqichma-bosqich
   o'tkazish.
2. Dark/light kontrast, klaviatura navigatsiyasi, focus holati, label va
   accessibility tekshiruvini bajarish.
3. Katta jadvallar uchun sticky ustun/sarlavha, gorizontal scroll va mobil card
   ko'rinishini yagona naqshga keltirish.
4. Loading, empty, error, confirmation va destructive action holatlarini
   standartlashtirish.
5. Login, xodimlar, grafik, davomat, hisobot, payroll, sozlamalar, Live Map va
   superadmin panel uchun desktop/mobile regression tekshiruvi yozish.

**Yakun mezoni:** asosiy sahifalarda alohida uslubdagi form/modal qolmagan va
mobil hamda desktop qabul testi o'tgan.

## 6. SaaS avtomatizatsiyasi va tugallanmagan integratsiyalar

1. Self-service trial: leadni tenantga aylantirish, admin hisobini yaratish,
   trial muddati, onboarding checklist, trial tugashi va pullik tarifga o'tish.
2. SMS fallback: email va Telegram mavjud bo'lmagan foydalanuvchi uchun parol
   tiklash provayderini tanlash va rate-limit/audit bilan ulash.
3. Didox: rasmiy API hujjati va haqiqiy test hisobi bilan endpoint/javob
   formatlarini tasdiqlash, E-IMZO oqimini stagingda sinash; taxminiy skeletonni
   tasdiqsiz production funksiyasi deb hisoblamaslik.
4. Face anti-spoofing/liveness: telefon ekrani yoki bosma surat bilan check-in'ni
   aniqlaydigan passiv model va fallback siyosati.
5. `OVERTIME_IN`/`OVERTIME_OUT` terminal eventlari uchun aniq biznes qoidasi,
   Director tasdig'i va payrollga auditli o'tkazish.
6. Mahsulot nomi va tenant atamalarini `StaffPlusPRO` hamda neytral
   “muassasa/tashkilot” tiliga yakuniy migratsiya qilish.

**Yakun mezoni:** har bir integratsiya uchun alohida staging/production qabul
testi mavjud; sozlanmagan integratsiya foydalanuvchiga tayyor funksiya sifatida
ko'rsatilmaydi.

## 7. Operatsion sifat va release avtomatizatsiyasi

1. CI pipeline qo'shish: Prisma generate, backend test/build, frontend typecheck,
   frontend build va asosiy regression testlar PR/pushni bloklasin.
2. Sentry App Router uchun global error handler qo'shish va eskirayotgan client
   konfiguratsiyasini `instrumentation-client`ga ko'chirish.
3. `/health` degraded holatini ham ushlaydigan tashqi monitoring va Face Match,
   Postgres, Redis, terminal gateway uchun alohida signal qo'shish.
4. Backup restore sinovini davriy qilish, natija va RPO/RTOni yozib borish.
5. Production secret/tokenlarni muntazam rotatsiya qilish va repository/console
   loglarida secret chiqmasligini avtomatik tekshirish.

**Yakun mezoni:** buzilgan build `main`ga kira olmaydi, degraded servis uchun
xabar keladi va oxirgi muvaffaqiyatli restore sanasi hujjatlashtirilgan.
