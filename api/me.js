import { listFromEnv, readSession } from './_session.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = await readSession(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  const email = String(session.email).toLowerCase();
  const isAdmin = session.role === 'admin' && listFromEnv('ADMIN_EMAILS').includes(email);
  return res.status(200).json({ email: session.email, name: session.name || '', role: isAdmin ? 'admin' : 'viewer' });
}
