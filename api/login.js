// Valida o token do Google NO SERVIDOR e só então cria a sessão.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { audit, createSession, isConfigured, sameOrigin, sessionCookie } from './_session.js';
import { decideLogin, loadAccess } from './_access.js';

const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'bad_origin' });
  if (!isConfigured()) return res.status(503).json({ error: 'not_configured' });

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
    if (decision.reason === 'unavailable') return res.status(503).json({ error: 'access_unavailable' });
    return res.status(403).json({ error: 'domain_not_allowed' });
  }

  // 3) Cria a sessão (cookie assinado, HttpOnly)
  const role = decision.admin ? 'admin' : 'viewer';
  const token = await createSession({ email: email, name: payload.name, role: role });
  res.setHeader('Set-Cookie', sessionCookie(token));
  audit('login_ok', { email: email, role: role });
  return res.status(200).json({ ok: true, email: email, role: role });
}
