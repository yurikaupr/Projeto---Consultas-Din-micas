// Resumo da política de acesso (somente leitura) para o painel de segurança.
// Qualquer usuário do painel (master ou admin) pode ver — dá a "certeza" de
// quem entra e sob qual regra. Não devolve a lista completa de viewers (só a
// contagem); os e-mails de master/admin aparecem porque são o time de operação.
import { requireAdmin } from '../_session.js';
import { isMaster, loadAccess } from '../_access.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const session = await requireAdmin(req, res);   // painel (master ou admin)
  if (!session) return;
  const actor = String(session.email).toLowerCase();

  const cfg = await loadAccess(true);
  if (cfg.unavailable) return res.status(503).json({ error: 'access_unavailable' });

  const owners = Array.from(cfg.owners);
  const fileMasters = Array.from(cfg.masters).filter((e) => !cfg.owners.has(e));

  return res.status(200).json({
    you: actor,
    role: isMaster(cfg, actor) ? 'master' : 'admin',
    domain: cfg.domain,
    mode: cfg.mode,                 // 'domain' (empresa toda) ou 'list' (somente lista)
    forced: cfg.envStrict,          // ALLOWED_EMAILS na Vercel força o modo lista
    source: cfg.source,             // 'github' | 'env' | 'unavailable'
    accessLog: (process.env.ACCESS_LOG || 'on').toLowerCase() !== 'off',
    owners: owners,                 // masters fixos (definidos na Vercel, imutáveis)
    masters: fileMasters,           // masters definidos no painel
    admins: Array.from(cfg.admins), // quem só sobe consultas
    counts: {
      masters: cfg.masters.size,
      admins: cfg.admins.size,
      viewers: cfg.viewers.size,
      blocked: cfg.blocked.size
    }
  });
}
