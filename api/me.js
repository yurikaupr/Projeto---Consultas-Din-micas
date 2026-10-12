import { readSession } from './_session.js';
import { canStay, isAdminEmail, isMaster, loadAccess, roleOf } from './_access.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = await readSession(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  const email = String(session.email).toLowerCase();
  const cfg = await loadAccess();
  if (cfg.unavailable && !cfg.owners.has(email)) return res.status(503).json({ error: 'access_unavailable' });
  if (!canStay(cfg, email)) return res.status(403).json({ error: 'revoked' });

  const master = isMaster(cfg, email);
  const panel = isAdminEmail(cfg, email);
  // Perfil exibido: master > admin > viewer
  const role = master ? 'master' : (panel ? 'admin' : (roleOf(cfg, email) || 'viewer'));

  return res.status(200).json({
    email: session.email,
    name: session.name || '',
    role: role,
    // Capacidades (o cliente usa para mostrar/ocultar; o servidor sempre reconfere)
    canPanel: panel,            // entra no painel admin
    canPublish: panel,          // sobe/publica consultas
    canManageUsers: master,     // gerencia usuários e acessos
    canViewLogs: master         // vê os logs de acesso
  });
}
