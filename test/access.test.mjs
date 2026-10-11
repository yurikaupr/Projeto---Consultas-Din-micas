// Teste da matriz de acesso do QueryHub (sem rede: o GitHub é simulado).
// Prova quem entra, quem é master, quem é admin e quem é barrado.
// Rodar:  node test/access.test.mjs
import assert from 'node:assert';

// ----- Simula o arquivo data/access.json vindo do GitHub -----
const FILE = {
  version: 1, mode: 'domain', users: [
    { email: 'master.painel@magazord.com.br', role: 'master' },
    { email: 'sobe.consulta@magazord.com.br', role: 'admin' },
    { email: 'so.consulta@magazord.com.br',  role: 'viewer' },
    { email: 'bloqueado@magazord.com.br',    role: 'blocked' },
    { email: 'parceiro@externo.com',         role: 'viewer' }   // fora do domínio, liberado na lista
  ]
};
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
let FAKE_FILE = FILE;
globalThis.fetch = async (url) => {
  if (String(url).includes('/contents/data/access.json')) {
    return { ok: true, status: 200, json: async () => ({ content: b64(JSON.stringify(FAKE_FILE)), sha: 'sha123' }) };
  }
  throw new Error('fetch inesperado: ' + url);
};

process.env.GITHUB_REPO = 'x/y';
process.env.GITHUB_TOKEN = 't';
process.env.ALLOWED_DOMAIN = 'magazord.com.br';
process.env.ADMIN_EMAILS = 'yuri.klug@magazord.com.br, yurikaupr@gmail.com';   // masters fixos (owners)
process.env.BLOCKED_EMAILS = 'banido.env@magazord.com.br';

const A = await import('../api/_access.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.log('  \x1b[31mFALHOU\x1b[0m ' + name); }
}
function login(cfg, email, hd, verified) {
  return A.decideLogin(cfg, { email, hd: hd === undefined ? email.split('@')[1] : hd, verified: verified !== false });
}

// ===== Modo "empresa" (domain) =====
let cfg = await A.loadAccess(true);

// --- MASTER: owners fixos + perfil master ---
check('owner yuri.klug é master', A.isMaster(cfg, 'yuri.klug@magazord.com.br'));
check('owner yurikaupr(gmail) é master', A.isMaster(cfg, 'yurikaupr@gmail.com'));
check('perfil master é master', A.isMaster(cfg, 'master.painel@magazord.com.br'));
check('admin NÃO é master', !A.isMaster(cfg, 'sobe.consulta@magazord.com.br'));
check('viewer NÃO é master', !A.isMaster(cfg, 'so.consulta@magazord.com.br'));
check('estranho NÃO é master', !A.isMaster(cfg, 'hacker@gmail.com'));

// --- PAINEL (isAdminEmail = master OU admin) ---
check('master acessa painel', A.isAdminEmail(cfg, 'master.painel@magazord.com.br'));
check('admin acessa painel', A.isAdminEmail(cfg, 'sobe.consulta@magazord.com.br'));
check('owner acessa painel', A.isAdminEmail(cfg, 'yuri.klug@magazord.com.br'));
check('viewer NÃO acessa painel', !A.isAdminEmail(cfg, 'so.consulta@magazord.com.br'));
check('estranho NÃO acessa painel', !A.isAdminEmail(cfg, 'hacker@gmail.com'));
check('bloqueado NÃO acessa painel', !A.isAdminEmail(cfg, 'bloqueado@magazord.com.br'));

// --- roleOf ---
check('roleOf owner = master', A.roleOf(cfg, 'yuri.klug@magazord.com.br') === 'master');
check('roleOf perfil master = master', A.roleOf(cfg, 'master.painel@magazord.com.br') === 'master');
check('roleOf admin = admin', A.roleOf(cfg, 'sobe.consulta@magazord.com.br') === 'admin');
check('roleOf viewer = viewer', A.roleOf(cfg, 'so.consulta@magazord.com.br') === 'viewer');
check('roleOf bloqueado = blocked', A.roleOf(cfg, 'bloqueado@magazord.com.br') === 'blocked');
check('roleOf conta do domínio = viewer', A.roleOf(cfg, 'alguem@magazord.com.br') === 'viewer');
check('roleOf estranho = null', A.roleOf(cfg, 'hacker@gmail.com') === null);

// --- LOGIN (modo empresa) ---
check('login owner → master', login(cfg, 'yuri.klug@magazord.com.br').role === 'master');
check('login admin → admin', login(cfg, 'sobe.consulta@magazord.com.br').role === 'admin');
check('login viewer → viewer', login(cfg, 'so.consulta@magazord.com.br').role === 'viewer');
check('login conta do domínio → viewer', login(cfg, 'novato@magazord.com.br').allowed === true);
check('login parceiro externo listado → permitido', login(cfg, 'parceiro@externo.com').allowed === true);

// *** As garantias que o usuário exigiu ***
check('GARANTIA: conta @gmail aleatória é NEGADA', login(cfg, 'hacker@gmail.com').allowed === false);
check('GARANTIA: domínio parecido (magazord.com.br.evil.com) é NEGADO', login(cfg, 'x@magazord.com.br.evil.com').allowed === false);
check('GARANTIA: e-mail do domínio mas com hd FALSO é NEGADO', login(cfg, 'spoof@magazord.com.br', 'gmail.com').allowed === false);
check('GARANTIA: e-mail do domínio sem verificação é NEGADO', login(cfg, 'nao.verificado@magazord.com.br', 'magazord.com.br', false).allowed === false);
check('GARANTIA: bloqueado é NEGADO no login', login(cfg, 'bloqueado@magazord.com.br').allowed === false);
check('GARANTIA: bloqueado por env é NEGADO', login(cfg, 'banido.env@magazord.com.br').allowed === false);

// --- canStay (a cada requisição) ---
check('canStay master', A.canStay(cfg, 'master.painel@magazord.com.br'));
check('canStay admin', A.canStay(cfg, 'sobe.consulta@magazord.com.br'));
check('canStay conta do domínio (modo empresa)', A.canStay(cfg, 'qualquer@magazord.com.br'));
check('canStay NEGA estranho @gmail', !A.canStay(cfg, 'hacker@gmail.com'));
check('canStay NEGA bloqueado', !A.canStay(cfg, 'bloqueado@magazord.com.br'));
check('canStay NEGA bloqueado por env', !A.canStay(cfg, 'banido.env@magazord.com.br'));

// ===== Separação dos dois admins (mesma regra do middleware) =====
// painel (master|admin): /admin.html e /api/admin/publish
// somente master:        /api/admin/access e /api/admin/logs
function allowed(email, path) {
  const adminPath = path === '/admin.html' || path.startsWith('/api/admin/');
  if (!adminPath) return true;
  if (!A.isAdminEmail(cfg, email)) return false;
  const masterPath = path.startsWith('/api/admin/access') || path.startsWith('/api/admin/logs');
  if (masterPath && !A.isMaster(cfg, email)) return false;
  return true;
}
const ADMIN_E = 'sobe.consulta@magazord.com.br', MASTER_E = 'master.painel@magazord.com.br', VIEWER_E = 'so.consulta@magazord.com.br';
check('ADMIN abre o painel', allowed(ADMIN_E, '/admin.html'));
check('ADMIN publica consultas', allowed(ADMIN_E, '/api/admin/publish'));
check('ADMIN é BARRADO em usuários (access)', !allowed(ADMIN_E, '/api/admin/access'));
check('ADMIN é BARRADO em logs', !allowed(ADMIN_E, '/api/admin/logs'));
check('MASTER abre o painel', allowed(MASTER_E, '/admin.html'));
check('MASTER publica consultas', allowed(MASTER_E, '/api/admin/publish'));
check('MASTER gerencia usuários', allowed(MASTER_E, '/api/admin/access'));
check('MASTER vê logs', allowed(MASTER_E, '/api/admin/logs'));
check('VIEWER é BARRADO no painel', !allowed(VIEWER_E, '/admin.html'));
check('VIEWER é BARRADO em publish', !allowed(VIEWER_E, '/api/admin/publish'));
check('owner (master fixo) vê logs', allowed('yuri.klug@magazord.com.br', '/api/admin/logs'));

// ===== Modo "somente lista" (ALLOWED_EMAILS força) =====
process.env.ALLOWED_EMAILS = 'convidado@magazord.com.br';
A.resetAccessCache();
let cfgList = await A.loadAccess(true);
check('modo lista ativo (forçado por env)', cfgList.mode === 'list' && cfgList.envStrict === true);
check('LISTA: conta do domínio fora da lista é NEGADA no login', login(cfgList, 'aleatorio@magazord.com.br').allowed === false);
check('LISTA: conta do domínio fora da lista NÃO pode ficar', !A.canStay(cfgList, 'aleatorio@magazord.com.br'));
check('LISTA: convidado da lista entra', login(cfgList, 'convidado@magazord.com.br').allowed === true);
check('LISTA: master continua entrando', A.canStay(cfgList, 'yuri.klug@magazord.com.br'));
check('LISTA: admin continua acessando painel', A.isAdminEmail(cfgList, 'sobe.consulta@magazord.com.br'));
delete process.env.ALLOWED_EMAILS;

// ===== Falha fechada: sem conseguir ler a lista, só owners entram =====
A.resetAccessCache();
globalThis.fetch = async () => { throw new Error('github caiu'); };
let cfgDown = await A.loadAccess(true);
check('FALHA FECHADA: indisponível marca unavailable', cfgDown.unavailable === true);
check('FALHA FECHADA: owner ainda entra', A.canStay(cfgDown, 'yuri.klug@magazord.com.br'));
check('FALHA FECHADA: conta do domínio NÃO entra', !A.canStay(cfgDown, 'alguem@magazord.com.br'));
check('FALHA FECHADA: login de não-owner negado', login(cfgDown, 'alguem@magazord.com.br').allowed === false);

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passaram, ' + fail + ' falharam\x1b[0m');
process.exit(fail ? 1 : 0);
