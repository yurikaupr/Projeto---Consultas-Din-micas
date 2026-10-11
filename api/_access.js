// Regras de acesso do QueryHub.
// Junta o que está na Vercel (variáveis, fixas) com o arquivo data/access.json (editável no painel admin).
// Roda no servidor comum e no Edge (middleware): por isso não usa nada exclusivo do Node.
//
// Perfis (do mais forte para o mais fraco):
//   master  → tudo: painel, publica consultas, gerencia usuários e vê logs de acesso.
//   admin   → painel e publica consultas. NÃO gerencia usuários nem vê logs.
//   viewer  → só consulta e baixa (ou qualquer conta do domínio, no modo "empresa").
//   blocked → não entra.
// Os e-mails em ADMIN_EMAILS (Vercel) são "owners": masters fixos que nunca perdem o acesso.

export const ACCESS_PATH = 'data/access.json';
export const AUDIT_PATH = 'data/audit-log.json';
export const ROLES = ['master', 'admin', 'viewer', 'blocked'];
export const MAX_USERS = 300;
export const MAX_AUDIT = 500;
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
    owners: listFromEnv('ADMIN_EMAILS'),          // masters fixos (nunca perdem o acesso)
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
  const owners = new Set(env.owners);                       // masters fixos (Vercel)
  const fileMasters = by('master');                         // masters editáveis (painel)
  return {
    source: source,
    sha: sha || null,
    domain: env.domain,
    fileMode: file ? file.mode : 'domain',
    envStrict: env.strict.length > 0,
    mode: env.strict.length ? 'list' : (file ? file.mode : 'domain'),
    owners: owners,
    masters: new Set(env.owners.concat(fileMasters)),       // todos os masters (fixos + do painel)
    admins: new Set(by('admin')),                           // apenas perfil "admin" (sobe consulta)
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

// Codifica em base64 sem depender do Buffer (funciona no Edge e no Node)
function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
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
// Sem nenhuma cópia, só os masters fixos entram (falha fechada).
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

// ---------------------------------------------------------------------------
// Decisões de acesso
// ---------------------------------------------------------------------------

// Decisão no momento do login (conhece o domínio da conta Google)
export function decideLogin(cfg, who) {
  const email = String(who.email || '').toLowerCase();
  if (!who.verified) return { allowed: false, reason: 'unverified' };
  if (cfg.envBlocked.has(email)) return { allowed: false, reason: 'blocked' };
  const owner = cfg.owners.has(email);
  if (!owner && cfg.blocked.has(email)) return { allowed: false, reason: 'blocked' };
  if (owner || cfg.masters.has(email)) return { allowed: true, admin: true, master: true, role: 'master' };
  if (cfg.admins.has(email)) return { allowed: true, admin: true, master: false, role: 'admin' };
  if (cfg.unavailable) return { allowed: false, reason: 'unavailable' };
  if (cfg.viewers.has(email)) return { allowed: true, admin: false, master: false, role: 'viewer' };
  const hd = String(who.hd || '').toLowerCase();
  if (cfg.mode === 'domain' && hd === cfg.domain && email.endsWith('@' + cfg.domain)) return { allowed: true, admin: false, master: false, role: 'viewer' };
  return { allowed: false, reason: 'not_allowed' };
}

// Decisão a cada requisição (a sessão já passou pelo login).
// Reconfere o domínio TODA vez: se alguém for removido da lista ou perder o
// vínculo com o domínio, a sessão aberta deixa de valer em até ~45s.
export function canStay(cfg, email) {
  email = String(email || '').toLowerCase();
  if (cfg.envBlocked.has(email)) return false;
  const owner = cfg.owners.has(email);
  if (!owner && cfg.blocked.has(email)) return false;
  if (owner || cfg.masters.has(email) || cfg.admins.has(email)) return true;
  if (cfg.unavailable) return false;
  if (cfg.viewers.has(email)) return true;            // liberado na lista (inclui externos)
  if (cfg.mode === 'list') return false;              // somente lista: fora da lista, sai
  return email.endsWith('@' + cfg.domain);            // modo empresa: só o domínio permanece
}

// Pode acessar o PAINEL admin (e publicar consultas): master OU admin.
export function isAdminEmail(cfg, email) {
  email = String(email || '').toLowerCase();
  if (cfg.envBlocked.has(email)) return false;
  if (cfg.owners.has(email)) return true;
  if (cfg.blocked.has(email)) return false;
  return cfg.masters.has(email) || cfg.admins.has(email);
}

// É MASTER: gerencia usuários/acessos e vê os logs. Só master pode.
export function isMaster(cfg, email) {
  email = String(email || '').toLowerCase();
  if (cfg.envBlocked.has(email)) return false;
  if (cfg.owners.has(email)) return true;          // owners (Vercel) são masters fixos
  if (cfg.blocked.has(email)) return false;
  return cfg.masters.has(email);
}

// Perfil efetivo da pessoa (para exibir e registrar). Owners contam como master.
export function roleOf(cfg, email) {
  email = String(email || '').toLowerCase();
  if (cfg.owners.has(email)) return 'master';
  if (cfg.envBlocked.has(email) || cfg.blocked.has(email)) return 'blocked';
  if (cfg.masters.has(email)) return 'master';
  if (cfg.admins.has(email)) return 'admin';
  if (cfg.viewers.has(email)) return 'viewer';
  if (cfg.mode === 'domain' && email.endsWith('@' + cfg.domain)) return 'viewer';
  return null;
}

// ---------------------------------------------------------------------------
// Logs de acesso (apenas master enxerga). Gravados em uma branch dedicada
// (GITHUB_AUDIT_BRANCH) para NÃO disparar um redeploy na Vercel a cada evento.
// Nunca guarda token nem conteúdo de consulta.
// ---------------------------------------------------------------------------

function auditEnabled() {
  return (process.env.ACCESS_LOG || 'on').toLowerCase() !== 'off';
}

function auditBranch() {
  // Por padrão usa uma branch separada da produção; assim os commits de log não republicam o site.
  return process.env.GITHUB_AUDIT_BRANCH || 'queryhub-audit';
}

function ghHeaders() {
  return {
    Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'queryhub'
  };
}

// Garante que a branch de logs existe (cria a partir da branch de produção na primeira vez)
async function ensureBranch(repo, branch, h) {
  const base = process.env.GITHUB_BRANCH || 'main';
  if (branch === base) return true;
  const ref = await fetch('https://api.github.com/repos/' + repo + '/git/ref/heads/' + encodeURIComponent(branch), { headers: h });
  if (ref.ok) return true;
  if (ref.status !== 404) return false;
  const baseRef = await fetch('https://api.github.com/repos/' + repo + '/git/ref/heads/' + encodeURIComponent(base), { headers: h });
  if (!baseRef.ok) return false;
  const sha = (await baseRef.json()).object.sha;
  const mk = await fetch('https://api.github.com/repos/' + repo + '/git/refs', {
    method: 'POST', headers: h, body: JSON.stringify({ ref: 'refs/heads/' + branch, sha: sha })
  });
  return mk.ok || mk.status === 422;   // 422 = já existe
}

// Registra um evento (best-effort: nunca quebra a requisição principal)
export async function appendAudit(entry) {
  const repo = process.env.GITHUB_REPO, token = process.env.GITHUB_TOKEN;
  if (!repo || !token || !auditEnabled()) return;
  const branch = auditBranch();
  const h = ghHeaders();
  const api = 'https://api.github.com/repos/' + repo + '/contents/' + AUDIT_PATH;
  try {
    if (!(await ensureBranch(repo, branch, h))) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      let sha = null, list = [];
      const get = await fetch(api + '?ref=' + encodeURIComponent(branch), { headers: h });
      if (get.ok) {
        const data = await get.json();
        sha = data.sha || null;
        try { list = JSON.parse(decodeBase64(data.content || '')); } catch (e) { list = []; }
        if (!Array.isArray(list)) list = [];
      } else if (get.status !== 404) {
        return;
      }
      list.push(entry);
      if (list.length > MAX_AUDIT) list = list.slice(list.length - MAX_AUDIT);
      const body = {
        message: 'log: ' + entry.event + (entry.email ? ' ' + entry.email : ''),
        content: encodeBase64(JSON.stringify(list)),
        branch: branch
      };
      if (sha) body.sha = sha;
      const put = await fetch(api, { method: 'PUT', headers: h, body: JSON.stringify(body) });
      if (put.ok) return;
      if (put.status !== 409 && put.status !== 422) return;
    }
  } catch (err) {
    // silencioso de propósito: log é secundário
  }
}

// Lê os últimos eventos (mais recentes primeiro). Só chamado por rota de master.
export async function loadAuditLog(limit) {
  const repo = process.env.GITHUB_REPO, token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return { configured: false, entries: [] };
  if (!auditEnabled()) return { configured: true, disabled: true, entries: [] };
  const branch = auditBranch();
  const h = ghHeaders();
  const res = await fetch('https://api.github.com/repos/' + repo + '/contents/' + AUDIT_PATH + '?ref=' + encodeURIComponent(branch), { headers: h });
  if (res.status === 404) return { configured: true, entries: [] };
  if (!res.ok) throw new Error('github_' + res.status);
  const data = await res.json();
  let list = [];
  try { list = JSON.parse(decodeBase64(data.content || '')); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  const n = Math.min(Math.max(Number(limit) || 200, 1), MAX_AUDIT);
  return { configured: true, branch: branch, total: list.length, entries: list.slice(-n).reverse() };
}
