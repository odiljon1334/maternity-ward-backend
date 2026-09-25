import {
  checkedInText,
  checkedOutText,
  checkinReminderText,
  checkoutDueText,
  durationUz,
  firstNameOf,
  linkedText,
} from './employee-messages';

describe('employee-messages', () => {
  it('ismni familiyadan keyingi so‘zdan oladi', () => {
    expect(firstNameOf('Karimova Dilnoza Akmalovna')).toBe('Dilnoza');
    expect(firstNameOf('Dilnoza')).toBe('Dilnoza');
    expect(firstNameOf(null)).toBe('');
  });

  it('davomiylik o‘zbekcha', () => {
    expect(durationUz(520)).toBe('8 soat 40 daq');
    expect(durationUz(45)).toBe('45 daq');
    expect(durationUz(120)).toBe('2 soat');
  });

  it('eslatma: vaqt, smena va qolgan daqiqa har bir variantda bor', () => {
    for (let seed = 0; seed < 3; seed++) {
      const t = checkinReminderText({
        fullName: 'Karimova Dilnoza',
        start: '08:00',
        shiftName: 'Kunduzgi smena',
        minutesLeft: 30,
        seed,
      });
      expect(t).toContain('<b>08:00</b>');
      expect(t).toContain('Kunduzgi smena');
      expect(t).toContain('30 daqiqa');
      expect(t).toContain('Dilnoza');
    }
  });

  it('kechikkan kelish — daqiqalar ko‘rsatiladi, maqtov varianti ishlatilmaydi', () => {
    const t = checkedInText({ fullName: 'A Dilnoza', time: '08:12', lateMinutes: 12, seed: 2 });
    expect(t).toContain('08:12');
    expect(t).toContain('12 daqiqa');
    expect(t).not.toContain("O'z vaqtida");
  });

  it('tungi smena kelishi — tinch tun tilagi', () => {
    expect(checkedInText({ time: '19:58', night: true })).toContain('Tungi smenangiz');
  });

  it('ketish — ishlagan vaqt, erta ketish va qo‘shimcha ish', () => {
    const t = checkedOutText({ time: '16:20', workedMin: 440, earlyLeaveMin: 40, seed: 0 });
    expect(t).toContain('7 soat 20 daq');
    expect(t).toContain('40 daqiqa oldin');
    const o = checkedOutText({ time: '18:00', workedMin: 540, overtimeMin: 60, seed: 1 });
    expect(o).toContain("Qo'shimcha ish: 1 soat");
  });

  it('HTML belgilar ekranlanadi (ism orqali in’ektsiya bo‘lmaydi)', () => {
    const t = checkoutDueText({ fullName: 'X <b>hack</b>', end: '17:00' });
    expect(t).not.toContain('<b>hack</b>');
    expect(linkedText([{ fullName: 'A B', hospitalName: '<i>H</i>' }])).toContain('&lt;i&gt;H&lt;/i&gt;');
  });
});
