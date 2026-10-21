jest.mock('ioredis', () => require('ioredis-mock'));

import { signAccessToken, verifyAccessToken } from '@ticketing/auth';
import { redis } from '@ticketing/redis';
import { revokeToken, rejectRevokedTokens } from '@ticketing/api/dist/middleware/tokenRevocation';

afterAll(() => redis.disconnect());

function run(token: string) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  return rejectRevokedTokens({ headers: { authorization: `Bearer ${token}` } } as any, res as any, next).then(() => ({ res, next }));
}

describe('Logout token revocation', () => {
  it('rejects a token after logout and leaves other tokens alone', async () => {
    const { token } = signAccessToken({ sub: 'user-1', email: 'a@b.c', role: 'USER' });
    const { token: other } = signAccessToken({ sub: 'user-1', email: 'a@b.c', role: 'USER' });

    expect((await run(token)).next).toHaveBeenCalled();

    await revokeToken(verifyAccessToken(token));

    const revoked = await run(token);
    expect(revoked.next).not.toHaveBeenCalled();
    expect(revoked.res.status).toHaveBeenCalledWith(401);
    expect((await run(other)).next).toHaveBeenCalled();
  });
});
