// Utilitários de sessão compartilhados pelas rotas /api (arquivos com "_" não viram rotas)
import { SignJWT, jwtVerify } from 'jose';

export const COOKIE_NAME = 'qh_session';
export const SESSION_HOURS = 8;

function secretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  return new TextEncoder().encode(secret);
}

export function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && secretKey());
}

export async function createSession(user) {
  return new SignJWT({ email: user.email, name: user.name || '' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(SESSION_HOURS + 'h')
    .sign(secretKey());
}

export async function readSession(req) {
  const key = secretKey();
  const header = req.headers.cookie || '';
  const part = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE_NAME + '='));
  if (!key || !part) return null;
  try {
    const { payload } = await jwtVerify(part.slice(COOKIE_NAME.length + 1), key, { algorithms: ['HS256'] });
    return payload;
  } catch (err) {
    return null;
  }
}

export function sessionCookie(token) {
  return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + SESSION_HOURS * 3600;
}

export function clearCookie() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
