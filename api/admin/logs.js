// Logs de acesso — SOMENTE MASTER (requireMaster + checagem no middleware).
// Lê os últimos eventos registrados (login, login negado, publicação, mudança
// de acessos). Nunca contém token nem conteúdo de consulta.
import { requireMaster } from '../_session.js';
import { loadAuditLog } from '../_access.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const session = await requireMaster(req, res);
  if (!session) return;

  const limit = Math.min(Math.max(parseInt(req.query && req.query.limit, 10) || 200, 1), 500);
  try {
    const out = await loadAuditLog(limit);
    if (!out.configured) return res.status(503).json({ error: 'github_not_configured' });
    return res.status(200).json(out);
  } catch (err) {
    return res.status(502).json({ error: 'github_read' });
  }
}
