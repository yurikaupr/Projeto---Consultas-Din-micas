import { clearCookie, sameOrigin } from './_session.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!sameOrigin(req)) return res.status(403).json({ error: 'bad_origin' });
  res.setHeader('Set-Cookie', clearCookie());
  res.status(200).json({ ok: true });
}
