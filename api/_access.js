// Regras de acesso do QueryHub.
// Junta o que está na Vercel (variáveis, fixas) com o arquivo data/access.json (editável no painel admin).
// Roda no servidor comum e no Edge (middleware): por isso não usa nada exclusivo do Node.

export const ACCESS_PATH = 'data/access.json';
export const ROLES = ['admin', 'viewer', 'blocked'];
export const MAX_USERS = 300;
export const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

const TTL_MS = 45000;     // quanto tempo uma cópia da lista vale (as mudanças chegam em até isso)
const RETRY_MS = 10000;   // espera antes de tentar de novo se o GitHub falhar

let cache = null;         // { cfg, expires }
let failedUntil = 0;
let inflight = null;

export function listFromEnv(name) {
  return (process.env[name] || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function envBase() {
  return {
    owners: listFromEnv('ADMIN_EMAILS'),          // administradores fixos (nunca perdem o acesso)
    blocked: listFromEnv('BLOCKED_EMAILS'),
    strict: listFromEnv('ALLOWED_EMAILS'),        // se preenchida, força "somente lista"
    extra: listFromEnv('EXTRA_ALLOWED_EMAILS'),
    domain: (process.env.ALLOWED_DOMAIN || 'magazord.com.br').toLowerCase()
  };
}

export function emptyFile() { return { version: 1, mode: 'domain', users: [] }; }

// Lê o arquivo com cuidado: ignora o que for inválido, em vez de quebrar
export function normalizeFile(data) {
  const file = emptyFile();
  if (!data || typeof data !== 'object') return file;
  file.mode = data.mode === 'list' ? 'list' : 'domain';
  const seen = new Set();
  (Array.isArray(data.users) ? data.users : []).slice(0, MAX_USERS).forEach((u) => {
    if (!u || typeof u !== 'object') return;
    const email = String(u.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 120 || seen.has(email) || ROLES.indexOf(u.role) === -1) return;
    seen.add(email);
    file.users.push({
      email: email,
      name: String(u.name || '').trim().slice(0, 80),
      role: u.role,
      added_by: String(u.added_by || '').slice(0, 120),
      added_at: Number(u.added_at) || 0
    });
  });
  return file;
}

// source: 'github' (arquivo lido) | 'env' (GitHub não configurado) | 'unavailable' (não consegui ler)
function buildConfig(file, source, sha) {
  const env = envBase();
  const users = file ? file.users : [];
  const by = (role) => users.filter((u) => u.role === role).map((u) => u.email);
  return {
    source: source,
    sha: sha || null,
    domain: env.domain,
    fileMode: file ? file.mode : 'domain',
    envStrict: env.strict.length > 0,
    mode: env.strict.length ? 'list' : (file ? file.mode : 'domain'),
    owners: new Set(env.owners),
    admins: new Set(by('admin')),
    viewers: new Set(by('viewer').concat(env.extra, env.strict)),
    blocked: new Set(by('blocked')),
    envBlocked: new Set(env.blocked),
    unavailable: source === 'unavailable',
    file: file
  };
}

function decodeBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function fetchFile() {
  const repo = process.env.GITHUB_REPO, token = process.env.GITHUB_TOKEN, branch = process.env.GITHUB_BRANCH || 'main';
  if (!repo || !token) return { configured: false, file: null, sha: null };
  const res = await fetch('https://api.github.com/repos/' + repo + '/contents/' + ACCESS_PATH + '?ref=' + encodeURIComponent(branch), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'queryhub' }
  });
  if (res.status === 404) return { configured: true, file: emptyFile(), sha: null };   // ainda não existe: vale o padrão
  if (!res.ok) throw new Error('github_' + res.status);
  const data = await res.json();
  let parsed;
  try { parsed = JSON.parse(decodeBase64(data.content || '')); } catch (err) { throw new Error('invalid_file'); }
  return { configured: true, file: normalizeFile(parsed), sha: data.sha || null };
}

// Carrega as regras (com cópia de curta duração). Se o GitHub falhar, usa a última cópia boa.
// Sem nenhuma cópia, só os administradores fixos entram (falha fechada).
export async function loadAccess(force) {
  const now = Date.now();
  if (!force && cache && now < cache.expires) return cache.cfg;
  if (!force && now < failedUntil) return cache ? cache.cfg : buildConfig(null, 'unavailable', null);
  if (!force && inflight) return inflight;
  inflight = (async () => {
    try {
      const got = await fetchFile();
      const cfg = buildConfig(got.file, got.configured ? 'github' : 'env', got.sha);
      cache = { cfg: cfg, expires: Date.now() + TTL_MS };
      failedUntil = 0;
      return cfg;
    } catch (err) {
      failedUntil = Date.now() + RETRY_MS;
      return cache ? cache.cfg : buildConfig(null, 'unavailable', null);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function setCache(file, sha) {
  cache = { cfg: buildConfig(file, 'github', sha), expires: Date.now() + TTL_MS };
  failedUntil = 0;
}

export function resetAccessCache() { cache = null; failedUntil = 0; inflight = null; }

// Decisão no momento do login (conhece o domínio da conta Google)
export function decideLogin(cfg, who) {
  const email = String(who.email || '').toLowerCase();
  if (!who.verified) return { allowed: false, reason: 'unverified' };
  if (cfg.envBlocked.has(email)) return { allowed: false, reason: 'blocked' };
  const owner = cfg.owners.has(email);
  if (!owner && cfg.blocked.has(email)) return { allowed: false, reason: 'blocked' };
  if (owner || cfg.admins.has(email)) return { allowed: true, admin: true };
  if (cfg.unavailable) return { allowed: false, reason: 'unavailable' };
  if (cfg.viewers.has(email)) return { allowed: true, admin: false };
  const hd = String(who.hd || '').toLowerCase();
  if (cfg.mode === 'domain' && hd === cfg.domain && email.endsWith('@' + cfg.domain)) return { allowed: true, admin: false };
  return { allowed: false, reason: 'not_allowed' };
}

// Decisão a cada requisição (a sessão já passou pelo login)
export function canStay(cfg, email) {
  email = String(email || '').toLowerCase();
  if (cfg.envBlocked.has(email)) return false;
  const owner = cfg.owners.has(email);
  if (!owner && cfg.blocked.has(email)) return false;
  if (owner || cfg.admins.has(email)) return true;
  if (cfg.unavailable) return false;
  if (cfg.mode === 'list') return cfg.viewers.has(email);
  return true;
}

export function isAdminEmail(cfg, email) {
  email = String(email || '').toLowerCase();
  if (cfg.envBlocked.has(email)) return false;
  if (cfg.owners.has(email)) return true;
  return cfg.admins.has(email) && !cfg.blocked.has(email);
}
