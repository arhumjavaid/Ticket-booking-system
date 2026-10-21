import { seatTierPrice } from '@ticketing/shared';

describe('seatTierPrice', () => {
  it('applies tier multipliers to the base price', () => {
    expect(seatTierPrice(75, 'VIP')).toBe(150);
    expect(seatTierPrice(75, 'PREMIUM')).toBe(112.5);
    expect(seatTierPrice(75, 'REGULAR')).toBe(75);
  });

  it('treats unknown tiers as regular and is case-insensitive', () => {
    expect(seatTierPrice(40, 'balcony')).toBe(40);
    expect(seatTierPrice(40, 'vip')).toBe(80);
  });

  it('prefers explicit per-tier prices', () => {
    expect(seatTierPrice(75, 'VIP', { VIP: 199 })).toBe(199);
    expect(seatTierPrice(75, 'PREMIUM', { VIP: 199 })).toBe(112.5);
  });
});
