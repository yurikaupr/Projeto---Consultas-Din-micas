// Valida o token do Google NO SERVIDOR e só então cria a sessão.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createSession, isConfigured, listFromEnv, sessionCookie } from './_session.js';

const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
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
    return res.status(401).json({ error: 'invalid_token' });
  }

  // 2) Confere o domínio. O campo "hd" só existe para contas Google Workspace do domínio.
  const domain = (process.env.ALLOWED_DOMAIN || 'magazord.com.br').toLowerCase();
  const extras = listFromEnv('EXTRA_ALLOWED_EMAILS');
  const admins = listFromEnv('ADMIN_EMAILS');

  const email = String(payload.email || '').toLowerCase();
  const verified = payload.email_verified === true;
  const fromDomain = verified &&
    String(payload.hd || '').toLowerCase() === domain &&
    email.endsWith('@' + domain);
  const isExtra = verified && extras.includes(email);
  const isAdmin = verified && admins.includes(email);

  if (!fromDomain && !isExtra && !isAdmin) return res.status(403).json({ error: 'domain_not_allowed' });

  // 3) Cria a sessão (cookie assinado, HttpOnly)
  const token = await createSession({ email, name: payload.name, role: isAdmin ? 'admin' : 'viewer' });
  res.setHeader('Set-Cookie', sessionCookie(token));
  return res.status(200).json({ ok: true, email, role: isAdmin ? 'admin' : 'viewer' });
}
