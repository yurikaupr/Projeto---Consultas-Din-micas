// Utilitários de sessão compartilhados pelas rotas /api (arquivos com "_" não viram rotas)
import { SignJWT, jwtVerify } from 'jose';
import { canStay, isAdminEmail, isMaster, listFromEnv, loadAccess } from './_access.js';

export { listFromEnv };

// O prefixo __Host- obriga o navegador a só aceitar o cookie via HTTPS, sem Domain e com Path=/
export const COOKIE_NAME = '__Host-qh_session';

function sessionHours() {
  const hours = Number(process.env.SESSION_HOURS) || 1;
  return Math.min(Math.max(hours, 1), 24);
}

function secretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  return new TextEncoder().encode(secret);
}

export function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && secretKey());
}

// Registro simples nos logs da Vercel (não grava tokens nem conteúdo das consultas)
export function audit(event, data) {
  console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString(), event: event }, data || {})));
}

// Defesa extra contra CSRF: a requisição precisa vir do próprio site.
// 1) Se houver Origin, ele TEM de bater com o host (bloqueia cross-site).
// 2) Sem Origin, aceita só Sec-Fetch-Site same-origin/none (o navegador sempre
//    envia esse cabeçalho em fetch() do próprio site; a página não consegue forjá-lo).
// 3) Sem nenhum dos dois, recusa: não é uma chamada legítima do site no navegador.
export function sameOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).host === host; } catch (err) { return false; }
  }
  const site = req.headers['sec-fetch-site'];
  return site === 'same-origin' || site === 'none';
}

export async function createSession(user) {
  return new SignJWT({ email: user.email, name: user.name || '', role: user.role || 'viewer' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(sessionHours() + 'h')
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

// Exige acesso ao PAINEL (master OU admin): entra no painel e publica consultas.
// O papel vem da lista de acessos atual (variável da Vercel + painel), e não do
// cookie: mudar a lista vale mesmo para quem já está com a sessão aberta.
export async function requireAdmin(req, res) {
  const session = await readSession(req);
  if (!session) { res.status(401).json({ error: 'unauthorized' }); return null; }
  const email = String(session.email).toLowerCase();
  const cfg = await loadAccess();
  if (cfg.unavailable && !cfg.owners.has(email)) { res.status(503).json({ error: 'access_unavailable' }); return null; }
  if (!canStay(cfg, email) || !isAdminEmail(cfg, email)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return session;
}

// Exige MASTER: gerenciar usuários/acessos e ver os logs. Admin comum não passa.
export async function requireMaster(req, res) {
  const session = await readSession(req);
  if (!session) { res.status(401).json({ error: 'unauthorized' }); return null; }
  const email = String(session.email).toLowerCase();
  const cfg = await loadAccess();
  if (cfg.unavailable && !cfg.owners.has(email)) { res.status(503).json({ error: 'access_unavailable' }); return null; }
  if (!canStay(cfg, email) || !isMaster(cfg, email)) { res.status(403).json({ error: 'forbidden_master' }); return null; }
  return session;
}

export function sessionCookie(token) {
  return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + sessionHours() * 3600;
}

export function clearCookie() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
