// Prova a defesa anti-abuso do log: um flood de eventos (ex.: /api/login sendo
// martelado) NÃO vira um flood de commits no GitHub. Os eventos são
// enfileirados e gravados em lote (no máx. ~1 commit por janela por instância),
// preservando os eventos importantes. GitHub é simulado (sem rede).
import assert from 'node:assert';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function unb64(s) { return Buffer.from(String(s), 'base64').toString('utf8'); }

let puts = 0;            // quantos commits (PUT) foram feitos
let store = null;        // conteúdo "persistido" (base64), ou null = 404

globalThis.fetch = async (url, opts) => {
  const u = String(url), method = (opts && opts.method) || 'GET';
  if (u.includes('/git/ref/heads/')) return { ok: true, status: 200, json: async () => ({ object: { sha: 'base' } }) };
  if (u.includes('/contents/data/audit-log.json')) {
    if (method === 'PUT') {
      puts++;
      const body = JSON.parse(opts.body);
      store = body.content;
      return { ok: true, status: 200, json: async () => ({ content: { sha: 's' + puts }, commit: { sha: 'c' + puts } }) };
    }
    if (store == null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ content: store, sha: 'cur' }) };
  }
  throw new Error('fetch inesperado: ' + u);
};

process.env.GITHUB_REPO = 'x/y';
process.env.GITHUB_TOKEN = 't';
process.env.GITHUB_AUDIT_BRANCH = 'queryhub-audit';

const A = await import('../api/_access.js');
let pass = 0, fail = 0;
function check(name, cond) { if (cond) pass++; else { fail++; console.log('  \x1b[31mFALHOU\x1b[0m ' + name); } }

// 1) Flood: 500 login_denied enfileirados => no máximo 1 commit (não 500)
for (let i = 0; i < 500; i++) {
  await A.recordAudit({ ts: '2026-01-01T00:00:00Z', event: 'login_denied', email: 'flood' + i + '@x.com', detail: 'not_allowed' });
}
await delay(120);  // deixa o flush em segundo plano terminar
check('flood de 500 eventos gera no máximo 1 commit (anti-DoS)', puts <= 1);
const afterFlood = puts;

// 2) Evento importante no meio do flood não é perdido
await A.recordAudit({ ts: '2026-01-01T00:01:00Z', event: 'access_updated', email: 'master@magazord.com.br', role: 'master', detail: 'mudou acessos' });

// 3) Ação autenticada (immediate) força a gravação na hora
await A.appendAudit({ ts: '2026-01-01T00:02:00Z', event: 'publish_ok', email: 'admin@magazord.com.br', role: 'admin', detail: '3 consultas' });
check('ação autenticada (immediate) faz exatamente mais 1 commit', puts === afterFlood + 1);

// 4) O que ficou persistido preserva os eventos importantes e respeita o teto
const persisted = JSON.parse(unb64(store));
check('lista persistida respeita o teto (<=500)', persisted.length <= 500);
check('evento importante access_updated foi preservado', persisted.some((e) => e.event === 'access_updated'));
check('evento importante publish_ok foi preservado', persisted.some((e) => e.event === 'publish_ok'));
check('nenhum token/credencial vaza nos logs', !JSON.stringify(persisted).match(/token|secret|credential|password/i));

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passaram, ' + fail + ' falharam\x1b[0m');
process.exit(fail ? 1 : 0);
