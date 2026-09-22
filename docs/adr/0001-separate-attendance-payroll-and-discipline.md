# ADR 0001: Davomat, ish haqi va intizomiy jarimani ajratish

- Status: Accepted
- Sana: 2026-09-22

## Kontekst

Eski model kechikish daqiqalarini haftalik 120 daqiqalik limitdan keyin avtomatik pul ushlanmasiga aylantirgan. Bu limit O‘zbekiston Mehnat kodeksida yo‘q. Davomat fakti, ishlanmagan vaqtga mutanosib haq va intizomiy jarima turli huquqiy tushunchalardir.

## Qaror

1. Davomat terminal yoki mobil manbadan kelgan haqiqiy vaqtni saqlaydi va pul jazosi chiqarmaydi.
2. Vaqtbay bazaviy haq tasdiqlangan payable time asosida hisoblanadi; bu intizomiy jarima deb nomlanmaydi.
3. Intizomiy jarima faqat tushuntirish, vakolatli qaror/buyruq va xodimni tanishtirish workflowi yakunlangandan keyin payroll ledgerga kiradi.
4. Contractual KPI va bir martalik rag‘bat mukofoti alohida turlardir.
5. Avans payroll deduction emas, ish haqining oldindan to‘langan qismi sifatida yuritiladi.
6. Tasdiqlangan payroll bevosita qayta yozilmaydi; keyingi o‘zgarish reversiya yoki korrektirovka yozuvi bilan amalga oshiriladi.

## Oqibatlar

- Avtomatik kechikish jarimasi production hisobidan chiqariladi.
- Eski `lateDeduction`, `manualBonus` va `manualDeduction` maydonlari migratsiya davrida moslik uchun saqlanadi, ammo yangi workflow uchun manba bo‘lmaydi.
- Yangi ledger yozuvlari sabab, huquqiy asos, qaror qiluvchi, buyruq va audit ma’lumotlarini saqlashi shart.
- Muassasa ichki mehnat va KPI hujjatlarini versiyalashi hamda xodim tanishganini qayd etishi kerak.

## Manba

Rasmiy huquqiy tadqiqot: [O‘zbekiston Mehnat kodeksi asosida payroll va davomat talablari](../research/uzbekistan-labor-payroll.md).
