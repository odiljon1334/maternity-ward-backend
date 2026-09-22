import {
  SUPPORT_BOT_OWNER_PROMPT,
  SUPPORT_BOT_SYSTEM_PROMPT,
  formalizeUzbekAddress,
} from './faq-prompt';

describe('support bot promptlari', () => {
  it("mijozga doimo hurmat shaklida va yetarlicha to'liq javob berishni talab qiladi", () => {
    expect(SUPPORT_BOT_SYSTEM_PROMPT).toContain('doimo «siz» deb murojaat qil');
    expect(SUPPORT_BOT_SYSTEM_PROMPT).toContain("Savolga to'liq");
    expect(SUPPORT_BOT_SYSTEM_PROMPT).not.toContain('3-5 gap');
  });

  it("tasdiqlangan tarif ma'lumotlarini promptda saqlaydi", () => {
    expect(SUPPORT_BOT_SYSTEM_PROMPT).toContain("599 000 so'm");
    expect(SUPPORT_BOT_SYSTEM_PROMPT).toContain("15 000 so'm");
    expect(SUPPORT_BOT_SYSTEM_PROMPT).toContain("12 000 so'm");
    expect(SUPPORT_BOT_SYSTEM_PROMPT).toContain('2 oy bepul');
  });

  it('operatorni mijoz deb qabul qilmaydigan alohida prompt beradi', () => {
    expect(SUPPORT_BOT_OWNER_PROMPT).toContain('loyiha egasi yoki operatori');
    expect(SUPPORT_BOT_OWNER_PROMPT).toContain(
      "mijoz sifatida sotuv oqimiga yo'naltirma",
    );
  });

  it('AI javobidagi norasmiy murojaat olmoshlarini himoya qatlamida almashtiradi', () => {
    expect(
      formalizeUzbekAddress(
        "Sen tekshiring. Sening javob: senga va sendan ma'lumot kerak.",
      ),
    ).toBe("Siz tekshiring. Sizning javob: sizga va sizdan ma'lumot kerak.");
  });
});
