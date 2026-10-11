// Lista de acessos: quem entra, quem administra e quem está bloqueado.
// GET devolve a lista atual. POST grava em data/access.json no GitHub (um commit por alteração).
import { audit, requireAdmin, sameOrigin } from '../_session.js';
import { ACCESS_PATH, EMAIL_RE, MAX_USERS, ROLES, loadAccess, setCache } from '../_access.js';

function headers() {
  return {
    Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'queryhub'
  };
}

function view(cfg, actor) {
  return {
    mode: cfg.fileMode,
    forced: cfg.envStrict,
    domain: cfg.domain,
    owners: Array.from(cfg.owners),
    users: cfg.file ? cfg.file.users : [],
    sha: cfg.sha,
    source: cfg.source,
    canSave: cfg.source === 'github',
    you: actor,
    youOwner: cfg.owners.has(actor)
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (req.method === 'POST' && !sameOrigin(req)) return res.status(403).json({ error: 'bad_origin' });

  const session = await requireAdmin(req, res);
  if (!session) return;
  const actor = String(session.email).toLowerCase();

  // Sempre lê a versão mais recente (ignora a cópia em memória)
  const cfg = await loadAccess(true);
  if (cfg.unavailable) return res.status(503).json({ error: 'access_unavailable' });

  if (req.method === 'GET') return res.status(200).json(view(cfg, actor));

  // ---------- POST ----------
  if (cfg.source !== 'github') return res.status(503).json({ error: 'github_not_configured' });
  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.users)) return res.status(400).json({ error: 'invalid_body' });
  if ((body.sha || null) !== (cfg.sha || null)) return res.status(409).json({ error: 'stale' });
  if (body.users.length > MAX_USERS) return res.status(400).json({ error: 'too_many' });

  const previous = {};
  (cfg.file ? cfg.file.users : []).forEach((u) => { previous[u.email] = u; });

  const seen = new Set(), users = [];
  for (const u of body.users) {
    const email = String((u && u.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'invalid_email', email: email });
    if (seen.has(email)) return res.status(400).json({ error: 'duplicate_email', email: email });
    if (ROLES.indexOf(u.role) === -1) return res.status(400).json({ error: 'invalid_role', email: email });
    if (cfg.owners.has(email)) return res.status(400).json({ error: 'owner_protected', email: email });
    seen.add(email);
    const before = previous[email];
    users.push({
      email: email,
      name: String(u.name || '').trim().slice(0, 80),
      role: u.role,
      added_by: before ? before.added_by : actor,
      added_at: before ? before.added_at : Date.now()
    });
  }

  // Ninguém pode se trancar para fora (os administradores fixos da Vercel sempre ficam)
  const actorIsOwner = cfg.owners.has(actor);
  if (!actorIsOwner) {
    const me = users.filter((u) => u.email === actor)[0];
    if (!me || me.role !== 'admin') return res.status(400).json({ error: 'self_demote' });
  }
  if (!cfg.owners.size && !users.some((u) => u.role === 'admin')) return res.status(400).json({ error: 'no_admin' });

  const file = { version: 1, mode: body.mode === 'list' ? 'list' : 'domain', users: users };
  const branch = process.env.GITHUB_BRANCH || 'main';
  const payload = {
    message: 'Atualiza acessos por ' + actor,
    content: Buffer.from(JSON.stringify(file, null, 2) + '\n', 'utf8').toString('base64'),
    branch: branch
  };
  if (cfg.sha) payload.sha = cfg.sha;

  const put = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPO + '/contents/' + ACCESS_PATH, {
    method: 'PUT', headers: headers(), body: JSON.stringify(payload)
  });
  if (put.status === 409 || put.status === 422) return res.status(409).json({ error: 'stale' });
  if (!put.ok) {
    audit('access_failed', { email: actor, status: put.status });
    return res.status(502).json({ error: put.status === 401 || put.status === 403 ? 'github_auth' : 'github_write' });
  }
  const data = await put.json();
  setCache(file, data.content && data.content.sha);

  audit('access_updated', {
    email: actor, mode: file.mode,
    admins: users.filter((u) => u.role === 'admin').length,
    viewers: users.filter((u) => u.role === 'viewer').length,
    blocked: users.filter((u) => u.role === 'blocked').length
  });
  return res.status(200).json(view(await loadAccess(), actor));
}
