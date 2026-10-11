import { readSession } from './_session.js';
import { canStay, isAdminEmail, loadAccess } from './_access.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = await readSession(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  const email = String(session.email).toLowerCase();
  const cfg = await loadAccess();
  if (cfg.unavailable && !cfg.owners.has(email)) return res.status(503).json({ error: 'access_unavailable' });
  if (!canStay(cfg, email)) return res.status(403).json({ error: 'revoked' });
  return res.status(200).json({ email: session.email, name: session.name || '', role: isAdminEmail(cfg, email) ? 'admin' : 'viewer' });
}
