# O‘zbekiston Mehnat kodeksi asosida payroll va davomat talablari

**Tekshirilgan sana:** 2026-09-22  
**Asosiy rasmiy manba:** [O‘zbekiston Respublikasi Mehnat kodeksi, LexUZ](https://lex.uz/docs/-6257288)

> Ushbu hujjat mahsulot va dasturiy ta’minot talablari uchun huquqiy tadqiqotdir, individual yuridik xulosa emas. Muassasaning mulkchilik shakli, budjet tashkiloti ekanligi, jamoa shartnomasi va kasaba uyushmasi mavjudligi yakuniy qoidalarni o‘zgartirishi mumkin. Productionga huquqiy hisob-kitob chiqarishdan oldin ichki hujjatlar mehnat huquqi mutaxassisi tomonidan tasdiqlanishi kerak.

## Qisqa xulosa

1. Tizim grafikni, real kelish-ketish vaqtini va overtime vaqtini aniq, alohida qayd etishi shart. “Haftasiga 120 daqiqa bepul kechikish” Mehnat kodeksida yo‘q.
2. Vaqtbay bazaviy ish haqi haqiqatda ishlab berilgan vaqtga bog‘lanishi mumkin. Ishlanmagan vaqt uchun bazaviy haqni mutanosib hisoblash bilan intizomiy jarima bir xil narsa emas va ular tizimda alohida yuritilishi kerak.
3. Kechikish uchun pul jarimasi avtomatik payroll formulasi bo‘la olmaydi. Avval yozma tushuntirish, vakolatli ish beruvchi qarori/buyrug‘i, xodimni buyruq bilan tanishtirish va qonundagi limitlar talab qilinadi.
4. KPI/mukofot mezonlari oldindan belgilangan va mehnatga haq to‘lash tizimiga kiritilgan bo‘lsa, direktorning qarori ichki hujjatdagi mezonlarga bog‘liq bo‘ladi. Shartlar bajarilgach mukofotni sababsiz bermaslik xavfli. Faqat tizimda nazarda tutilmagan bir martalik rag‘bat mukofoti ish beruvchining alohida qaroriga ko‘ra beriladi.
5. Ish haqi, qoida tariqasida, ikki qismda — bo‘nak va qolgan hisob-kitob — 16 kundan ko‘p bo‘lmagan tanaffus bilan to‘lanadi.
6. Har bir to‘lovdagi jami ushlab qolish odatda hisoblangan ish haqining 50 foizidan oshmasligi kerak.
7. Overtime odatda xodimning yozma roziligini va aniq hisobini talab qiladi; birinchi ikki soat kamida 1,5 hissa, undan ortiq qism kamida 2 hissa to‘lanadi.

## 1. Ish vaqti, grafik va kechikishni qayd etish

### Huquqiy talab

- **181-modda:** ish vaqti — xodim ichki tartib, smena grafigi, boshqa ichki hujjat yoki mehnat shartnomasiga ko‘ra mehnat vazifasini bajarishi kerak bo‘lgan vaqt; haqiqatda vazifa bajarilgan vaqt ham ish vaqtiga kiradi. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **191-modda:** ish rejimi smena boshlanishi, tugashi, davomiyligi, tanaffuslar va ish/dam olish kunlari almashuvini belgilaydi; bu rejim ichki tartib, smena grafigi, boshqa ichki hujjat yoki mehnat shartnomasida belgilanadi. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **198-modda:** ish vaqtini hisobga olishning vazifasi har bir xodim haqiqatda ishlab bergan vaqtni aniqlashdir; kunlik, haftalik yoki jamlab hisobga olish qo‘llanishi mumkin. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **200-modda:** ish beruvchi kelish va ketishni hisobga olishni tashkil qilishi shart; qayd apparat, apparat-dasturiy yoki dasturiy vosita bilan yuritilishi mumkin; overtime va boshqa maxsus vaqtlar alohida hisobga olinadi. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **184-modda:** alohida xususiyatga ega bo‘lgan ayrim tibbiyot xodimlari uchun haftalik ish vaqti ko‘pi bilan 36 soat; aniq ro‘yxat va davomiylik Vazirlar Mahkamasi tomonidan belgilanadi. Klinikalar barcha tibbiyot xodimlarini avtomatik 40 soatlik rejimga qo‘ymasligi kerak. [Rasmiy manba](https://lex.uz/docs/-6257288)

### Mahsulotga talab

- Har bir kun uchun `scheduledStart`, `scheduledEnd`, tanaffus, `actualCheckIn`, `actualCheckOut`, manba va barcha manual tuzatishlar saqlansin.
- Erta kelish kechikish emas: `actualCheckIn <= scheduledStart` bo‘lsa `lateMinutes = 0`, real kelish vaqti esa o‘zgartirilmasin.
- Erta ketish, kechikish va overtime bir-biridan alohida metrika bo‘lsin.
- Grafik topilmasa, boshqa smenani taxminiy tanlab xodimni kechikkan deb belgilash mumkin emas; holat `REVIEW_REQUIRED` bo‘lishi kerak.
- Terminal ma’lumoti original/audit holatda saqlansin; director qilgan tuzatish eski qiymatni o‘chirib yubormasin.

## 2. Vaqtbay ish haqi va ishlanmagan vaqt

### Huquqiy talab

- **248-modda:** ish haqi bazaviy va qo‘shimcha/o‘zgaruvchan qismlardan iborat. Bazaviy qism amaldagi haq to‘lash tizimi asosida, haqiqatda ishlab berilgan vaqt yoki bajarilgan ish uchun hisoblanadi. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **249-modda:** haq to‘lash tizimi mehnat miqdori/sifati va shaxsiy/jamoaviy natijalarga bog‘liqlik usulidir; vaqtbay, ishbay yoki boshqa qonuniy mezonlar qo‘llanishi mumkin. Tizim ish beruvchi tomonidan kasaba uyushmasi qo‘mitasi bilan kelishuvga ko‘ra belgilanadi; budjet tashkilotlarida alohida qonunchilik amal qiladi. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **265-modda:** xodim aybi bilan mehnat normalari yoki vazifalar bajarilmasa, ish haqining normalashtirilgan qismi bajarilgan ish hajmiga muvofiq to‘lanadi. Ish beruvchi aybi yoki taraflarga bog‘liq bo‘lmagan sabablar uchun boshqa kafolatlar mavjud. [Rasmiy manba](https://lex.uz/docs/-6257288)

### Muhim ajratish

- **Ishlanmagan vaqt uchun bazaviy haqni hisoblamaslik/proratsiya** — vaqtbay haqning hisob-kitobi.
- **Intizomiy jarima** — alohida huquqiy jazo bo‘lib, 312–314-moddalardagi protsedurasiz qo‘llanmaydi.

Tizim `absenceDeduction` nomi bilan avtomatik jarima yaratmasligi kerak. Uning o‘rniga bazaviy ish haqining formulasi `normativeMinutes`, `payableWorkedMinutes` va qonun bilan haq saqlanadigan vaqtlar asosida hisoblanishi kerak. Ta’til, kasallik, ish beruvchi aybi bilan bekor turish va boshqa kafolatli davrlar oddiy “kelmadi” bilan tenglashtirilmasin.

## 3. Intizomiy jarima va majburiy protsedura

### Huquqiy talab

- **312-modda:** ruxsat etilgan choralar — hayfsan; o‘rtacha oylik ish haqining ko‘pi bilan 30 foizi miqdorida jarima; ichki mehnat tartibi qoidalarida nazarda tutilgan hollarda ko‘pi bilan 50 foizgacha jarima; tegishli asoslarda mehnat shartnomasini bekor qilish. Qonunda nazarda tutilmagan jazo qo‘llanmaydi. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **313-modda:** jazo ishga qabul qilish vakolati berilgan shaxs/organ tomonidan qo‘llanadi; jazodan oldin yozma tushuntirish talab qilinadi; bir qilmish uchun faqat bitta jazo; og‘irlik, holatlar, oldingi ish va xulq-atvor hisobga olinadi; jazo buyruq bilan rasmiylashtiriladi; buyruq sabablari bilan uch ish kuni ichida xodim imzo qo‘yib tanishtiriladi. Buyruq bilan tanishtirilmagan xodim intizomiy jazosi bo‘lmagan deb hisoblanadi. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **314-modda:** jazo qilmish aniqlangach darhol, odatda aniqlanganidan bir oy ichida va sodir etilganidan olti oy ichida qo‘llanadi; ayrim tekshiruv/audit holatlarida ikki yillik chegara mavjud. [Rasmiy manba](https://lex.uz/docs/-6257288)

### Mahsulotga talab

Avtomatik “late minutes → pul jarima” formulasi o‘chirilsin. Workflow:

1. Davomat hodisasi va dalillar yaratiladi.
2. Director xodimdan yozma/elektron tushuntirish so‘raydi.
3. Xodim tushuntirish beradi yoki rad etish dalolatnomasi biriktiriladi.
4. Vakolatli shaxs holatni va oldingi xulqni ko‘rib chiqadi.
5. Qaror: jazosiz yopish, hayfsan, qonuniy limitdagi jarima yoki boshqa qonuniy chora.
6. Buyruq yaratiladi va xodimga uch ish kuni ichida tanishtiriladi.
7. Faqat kuchga kirgan, tanishtirilgan buyruq payroll ushlab qolishiga o‘tadi.

Saqlanishi zarur audit maydonlari: hodisa, dalil, tushuntirish so‘rovi va muddati, xodim javobi/rad dalolatnomasi, qaror qiluvchi vakolati, buyruq raqami/sanasi, huquqiy asos, xodim tanishgan sana/usuli, e’tiroz, bekor qilish tarixi.

## 4. Ish haqidan ushlab qolish va limitlar

### Huquqiy talab

- **269-modda:** umumiy qoida bo‘yicha ushlab qolish xodimning yozma roziligi bilan amalga oshiriladi. Roziliksiz faqat moddada sanalgan holatlar, jumladan soliq, ijro hujjati, ish haqi hisobiga berilgan bo‘nak, ayrim zararlar va 312-modda bo‘yicha qonuniy jarima uchun mumkin. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **269-modda:** qaytarilmagan bo‘nak yoki hisob xatosi bo‘yicha ish beruvchi tegishli muddatdan bir oy ichida buyruq chiqarishi mumkin; muddat o‘tgan yoki xodim asos/miqdorga e’tiroz bildirgan bo‘lsa, undirish sud tartibida amalga oshiriladi. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **270-modda:** har bir to‘lovda jami ushlab qolish xodimga haqiqatda hisoblangan ish haqining 50 foizidan oshmaydi; aliment va axloq tuzatish ishlari bo‘yicha ayrim istisnolarda 70 foizgacha. [Rasmiy manba](https://lex.uz/docs/-6257288)

### Mahsulotga talab

- `deductionType`, huquqiy asos, rozilik/buyruq/ijro hujjati va limitga kirish tartibi saqlansin.
- 50 foizlik cap barcha ushlab qolishlar yig‘indisiga nisbatan tekshirilsin, faqat bitta jarimaga emas.
- Limitdan oshgan summa keyingi davrga faqat qonuniy asos saqlangan holda ko‘chiriladi; tizim net ish haqini manfiy qilmasin.
- Bazaviy haqning ishlangan vaqtga mutanosib hisoblanishi “ushlab qolish” bilan aralashtirilmasin va payslipda alohida ko‘rsatilsin.

## 5. KPI, bonus va direktor diskretsiyasi

### Huquqiy talab

- **246-modda:** haq miqdori ish murakkabligi, sharoitlari, malaka, ishchanlik sifati, mehnat natijalari va tashkilot natijalarini hisobga olib, amaldagi haq to‘lash tizimiga muvofiq belgilanadi; mukofotlash tizimlari jamoa kelishuvi, jamoa shartnomasi, kasaba uyushmasi bilan kelishilgan ichki hujjat yoki mehnat shartnomasida belgilanadi. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **248-modda:** mukofot va rag‘batlantiruvchi to‘lovlar ish haqining o‘zgaruvchan qismiga kiradi. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **252-modda:** oldindan belgilangan ko‘rsatkich va shartlarga erishish uchun haq to‘lash tizimida nazarda tutilgan mukofot ish haqining tarkibiy qismidir. Tizimda nazarda tutilmagan bir martalik mukofot esa muayyan voqea yoki alohida xizmat uchun ish beruvchi qaroriga ko‘ra beriladi. Mukofotlash tizimlari kasaba uyushmasi bilan kelishuvga ko‘ra belgilanadi; budjet tashkilotlarida alohida tartib mavjud. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **24-modda:** ish beruvchi xodimni halol, samarali mehnati uchun rag‘batlantirish huquqiga ega. [Rasmiy manba](https://lex.uz/docs/-6257288)

### Natija

KPI uchun ikki tur qat’iy ajratilishi kerak:

1. **Contractual/system KPI bonus:** oldindan e’lon qilingan mezonlar va formula. Mezonga erishilganda direktor faqat nizomda yozilgan, tekshiriladigan sabab bilan tasdiqlaydi/rad etadi. Sababsiz “beraman yoki bermayman” mumkin emas.
2. **Discretionary one-time award:** tizimdagi KPI formulasi emas; muayyan voqea yoki alohida xizmat uchun direktor qarori va buyruq bilan beriladigan bir martalik mukofot.

Har bir KPI qarorida mezon versiyasi, dalillar, hisoblangan summa, tasdiqlovchi/rad etuvchi, sabab, buyruq va audit tarixi bo‘lsin. KPI rad etilishi intizomiy jarimani yashirin qo‘llash vositasiga aylanmasligi kerak.

## 6. Bo‘nak (avans) va oylik yakuniy hisob-kitob

### Huquqiy talab

- **253-modda:** ish haqi to‘lash sanalari jamoa shartnomasi, ichki hujjat yoki mehnat shartnomasida belgilanadi va har yarim oyda bir martadan kam bo‘lishi mumkin emas; oylik ish haqi, qoida tariqasida, 16 kundan ko‘p bo‘lmagan tanaffus bilan bo‘nak va qolgan qismga bo‘lib to‘lanadi. Dam olish/bayram kuniga to‘g‘ri kelsa, oldin to‘lanadi. Ish beruvchi xodim so‘raganda hisoblashlar va ushlab qolishlar haqida xabar berishi shart. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **269-modda:** ish haqi hisobiga berilgan bo‘nak yakuniy hisob-kitobda ushlab qolinishi mumkin; boshqa turdagi qaytarilmagan bo‘naklar uchun bir oylik buyruq muddati va nizolashilganda sud tartibi amal qiladi. [Rasmiy manba](https://lex.uz/docs/-6257288)

### Mahsulotga talab

- `PayrollPeriod` ichida `grossAccrued`, birinchi to‘lov/bo‘nak, yakuniy hisob, soliqlar, qonuniy ushlab qolishlar va `netPayable` alohida bo‘lsin.
- “Ish haqi hisobiga bo‘nak” bilan xodimga berilgan qarz/moddiy yordam aralashtirilmasin.
- Ikki to‘lov sanasi muassasa ichki hujjatiga mos sozlanadi; bayram/dam olish kuniga tushsa oldingi ish kuniga ko‘chiriladi.
- Payslipda bazaviy haq, overtime, KPI, bir martalik bonus, bo‘nak, soliqlar, har bir ushlab qolish asosi va yakuniy summa ko‘rinsin.

## 7. Overtime

### Huquqiy talab

- **189-modda:** ish beruvchi tomonidan belgilangan ish vaqtidan tashqari ishga jalb qilish overtime hisoblanadi. Kundalik rejimda smena davomiyligidan oshgan ish overtime; jamlab hisobda hisob davri normasi bo‘yicha aniqlanadi. Favqulodda sanalgan holatlardan tashqari yozma rozilik talab qilinadi. 12 soatlik smenada va o‘ta zararli/o‘ta xavfli ishlarda overtimega yo‘l qo‘yilmaydi. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **190-modda:** overtime ketma-ket ikki kunda to‘rt soatdan oshmasligi kerak (noqulay sharoitlarda bir kunda ikki soat); ish beruvchi davomiylikni aniq hisobga olishi shart. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **262-modda (2025-yilgi tahrir):** bir kundagi birinchi ikki soat uchun kamida 1,5 hissa, ikki soatdan ortiq qismi uchun kamida 2 hissa to‘lanadi; yuqoriroq stavka ichki hujjat/shartnomada belgilanishi mumkin. Xodim xohlasa, oshirilgan haq o‘rniga mos qo‘shimcha dam olish vaqti berilib, overtime bir hissa to‘lanishi mumkin. [Rasmiy manba](https://lex.uz/docs/-6257288)

### Mahsulotga talab

- Kech check-outning o‘zi avtomatik overtime to‘lovi uchun yetarli dalil emas. Tizim real vaqtni qayd etadi, lekin overtime “ish beruvchi tomonidan jalb qilingan/ma’qullangan ish” sifatida rozilik yoki favqulodda asos bilan tasdiqlanishi kerak.
- Workflow: `DETECTED → EMPLOYEE_CONFIRMATION/CONSENT → DIRECTOR_APPROVAL → PAYABLE` yoki `REJECTED`.
- Birinchi 120 daqiqa 1,5x, keyingi daqiqalar 2x; kunlik va ikki kunlik limitlar avtomatik tekshirilsin.
- Check-out yo‘q bo‘lsa grafik tugash vaqtida avtomatik yopish overtime yaratmasligi — to‘g‘ri xavfsiz qoida; hodisa audit va Director ogohlantirishida qoladi.

## 8. Xodimni hujjatlar bilan tanishtirish va tizimdagi “Mehnat kodeksi” bo‘limi

### Huquqiy talab

- **25-modda:** ish beruvchi xodimlarni ularning mehnat faoliyati bilan bevosita bog‘liq qabul qilinayotgan ichki hujjatlar bilan imzo qo‘ydirib tanishtirishi shart. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **78-modda:** jamoa shartnomasi kuchga kirgach o‘n kun ichida xodimlar imzo qo‘yib tanishtiriladi; ishga qabul qilinayotgan xodim ham jamoa shartnomasi bilan tanishtiriladi. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **123-modda:** mehnat shartnomasi imzolanishidan oldin xodim ish mazmuni, mehnat sharoitlari, ichki mehnat tartibi, jamoa shartnomasi va bevosita bog‘liq boshqa ichki hujjatlar bilan tanishtirilishi shart. [Rasmiy manba](https://lex.uz/docs/-6257288)
- **253-modda:** xodim so‘raganda ish haqi hisob-kitobi va ushlab qolishlar to‘g‘risida xabardor qilinishi shart. [Rasmiy manba](https://lex.uz/docs/-6257288)

### Mahsulotga talab

Director va xodim portalida alohida **“Mehnat huquqi va ichki hujjatlar”** bo‘limi bo‘lsin:

- LexUZdagi amaldagi Mehnat kodeksiga rasmiy havola va mavzu/modda bo‘yicha qisqa yo‘riqnoma;
- muassasaning jamoa shartnomasi, ichki mehnat tartibi, haq to‘lash/KPI nizomi, intizomiy jazo va bo‘nak siyosati;
- hujjat versiyasi, kuchga kirish sanasi va kim tasdiqlagani;
- xodim “o‘qidim/tanishdim” tasdig‘i, sana, usul, IP/device va hujjat hash/versioni;
- yangi versiya chiqqanda qayta tanishtirish;
- payslip va o‘ziga tegishli buyruqlarni yuklab olish;
- Director uchun tanishmagan xodimlar reyestri.

Faqat kodeks linkini ko‘rsatish 25, 78 va 123-moddalardagi ichki hujjatlar bilan tanishtirish majburiyatini o‘zi bajarmaydi; imzo/tasdiq va versiyalangan audit zarur.

## 9. Tavsiya etiladigan domain/workflow modeli

1. **Attendance facts:** terminal/mobile hodisalari, jadval, haqiqiy vaqt, o‘zgarmas audit.
2. **Payable time classification:** oddiy ish, overtime, haq saqlanadigan vaqt, haq to‘lanmaydigan vaqt, tekshiruv talab qiluvchi vaqt.
3. **Compensation policy:** bazaviy stavka, qonuniy qo‘shimcha to‘lovlar, contractual KPI, discretionary award.
4. **Disciplinary case:** qilmish, tushuntirish, qaror, buyruq, tanishtirish, appeal/audit.
5. **Payroll ledger:** accrual va deduction ikki tomonlama alohida yozuvlar; har bir yozuvda huquqiy asos va manba hujjat.
6. **Payment schedule:** bo‘nak va yakuniy to‘lov, to‘lov holati, bank hujjati.
7. **Legal document center:** amaldagi kodeks havolalari va muassasa ichki hujjatlari, versiya/tanishish auditi.

Payroll hisobini yakunlashdan oldin quyidagi bloklovchi validatsiyalar ishlashi kerak:

- tasdiqsiz intizomiy jarima mavjud emas;
- 50% umumiy ushlab qolish cap buzilmagan;
- overtime uchun tegishli rozilik/asos va tasdiq bor;
- KPI amaldagi mezon versiyasi bilan hisoblangan;
- bo‘nak yakuniy hisobda faqat bir marta ayrilgan;
- barcha summalar payslipda tushunarli ajratilgan;
- payroll tasdiqlangach o‘zgartirish faqat reversiya/korrektirovka yozuvi bilan amalga oshiriladi.

## Risklar va tavsiyalar

- **Eng yuqori risk:** avtomatik kechikish jarimasi. Uni production payrolldan chiqarib, intizomiy case/buyruq workflowiga o‘tkazish kerak.
- **Yuqori risk:** KPI mezoni bajarilgan bo‘lsa ham direktorning sababsiz rad etishi. Contractual KPI va discretionary award alohida modellar bo‘lishi kerak.
- **Yuqori risk:** oddiy kech check-outni tasdiqsiz overtime deb to‘lash yoki umuman to‘lamaslik. Real vaqt, jalb qilish asosi, rozilik va tasdiq birga saqlanishi kerak.
- **Yuqori risk:** 50% capni faqat jarimaga qo‘llab, soliq/ijro/bo‘nak bilan umumiy yig‘indini tekshirmaslik.
- **O‘rta risk:** faqat umumiy 40 soatlik rejim. Ayrim tibbiyot xodimlari uchun 36 soat yoki boshqa maxsus norma bo‘lishi mumkin.
- **Tavsiya:** avval muassasa uchun “Mehnatga haq to‘lash va KPI nizomi”, “Ichki mehnat tartibi”, “Intizomiy ish yuritish tartibi” va “Bo‘nak/to‘lov kalendari” tasdiqlansin; keyin tizim formulalari shu versiyalangan hujjatlarga bog‘lansin.

