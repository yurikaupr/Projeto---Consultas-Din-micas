// Valida o token do Google NO SERVIDOR e só então cria a sessão.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { audit, createSession, isConfigured, sameOrigin, sessionCookie } from './_session.js';
import { decideLogin, loadAccess, recordAudit } from './_access.js';

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : String(fwd || '')).split(',')[0].trim();
}

// Limite por instância e por IP: blinda o /api/login (rota pública) contra
// replay/flood. Não é o único freio — o log é enfileirado e a Vercel absorve
// volume — mas levanta a barra de graça. Janela fixa de 1 minuto.
const RL = new Map();
const RL_MAX = 30, RL_WINDOW = 60000;
function rateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  if (RL.size > 5000) { for (const [k, v] of RL) { if (now >= v.resetAt) RL.delete(k); } }
  let e = RL.get(ip);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + RL_WINDOW }; RL.set(ip, e); }
  e.count++;
  return e.count > RL_MAX;
}

const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'bad_origin' });
  if (!isConfigured()) return res.status(503).json({ error: 'not_configured' });

  // Freio de abuso antes de qualquer trabalho pesado (verificação do token)
  if (rateLimited(clientIp(req))) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: 'rate_limited' }); }

  const credential = req.body && req.body.credential;
  if (typeof credential !== 'string' || !credential) return res.status(400).json({ error: 'missing_credential' });

  // 1) Confere assinatura, emissor, validade e se o token foi emitido para o NOSSO Client ID
  let payload;
  try {
    ({ payload } = await jwtVerify(credential, GOOGLE_KEYS, {
      issuer: GOOGLE_ISSUERS,
      audience: process.env.GOOGLE_CLIENT_ID
    }));
  } catch (err) {
    audit('login_invalid_token');
    return res.status(401).json({ error: 'invalid_token' });
  }

  // 2) Regras de acesso: variáveis da Vercel + lista editada no painel admin
  const cfg = await loadAccess();
  const email = String(payload.email || '').toLowerCase();
  const decision = decideLogin(cfg, { email: email, verified: payload.email_verified === true, hd: payload.hd });

  if (!decision.allowed) {
    audit('login_denied', { email: email, reason: decision.reason });
    // Enfileira (NÃO bloqueia, NÃO faz commit por requisição): rota pública.
    recordAudit({ ts: new Date().toISOString(), event: 'login_denied', email: email, role: null, detail: decision.reason, ip: clientIp(req) });
    if (decision.reason === 'unavailable') return res.status(503).json({ error: 'access_unavailable' });
    // Resposta genérica de propósito: não revela domínio nem motivo (anti-engenharia social)
    return res.status(403).json({ error: 'access_denied' });
  }

  // 3) Cria a sessão (cookie assinado, HttpOnly). O papel é master | admin | viewer.
  const role = decision.role || (decision.admin ? 'admin' : 'viewer');
  const token = await createSession({ email: email, name: payload.name, role: role });
  res.setHeader('Set-Cookie', sessionCookie(token));
  audit('login_ok', { email: email, role: role });
  recordAudit({ ts: new Date().toISOString(), event: 'login_ok', email: email, role: role, detail: 'entrou', ip: clientIp(req) });
  return res.status(200).json({ ok: true, email: email, role: role });
}
