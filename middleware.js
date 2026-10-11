// Exige uma sessão válida (cookie assinado) para entregar qualquer arquivo do site.
// Sem sessão: páginas redirecionam para /login.html e as demais requisições recebem 401.
// A cada requisição confere a lista de acessos (variáveis da Vercel + data/access.json),
// então bloquear ou tirar o acesso de alguém vale mesmo para quem já está logado.
import { next } from '@vercel/edge';
import { jwtVerify } from 'jose';
import { canStay, isAdminEmail, isMaster, loadAccess } from './api/_access.js';

export const config = {
  matcher: '/((?!_vercel).*)'
};

const COOKIE_NAME = '__Host-qh_session';

// Rotas que precisam ser públicas para o login funcionar
const PUBLIC_PATHS = [
  '/login.html',
  '/privacidade.html',
  '/css/style.css',
  '/css/login.css',
  '/js/login.js',
  '/js/theme.js',
  '/robots.txt',
  '/api/login',
  '/api/config',
  '/api/logout'
];

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  const part = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return part ? part.slice(name.length + 1) : '';
}

function isAdminPath(pathname) {
  return pathname === '/admin.html' || pathname === '/admin' || pathname.startsWith('/api/admin/');
}

// Rotas que só o MASTER acessa: gerência de usuários, logs e painel de segurança.
function isMasterPath(pathname) {
  return pathname.startsWith('/api/admin/access') ||
         pathname.startsWith('/api/admin/logs') ||
         pathname.startsWith('/api/admin/status');
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

// Redirecionamento relativo: mantém o endereço em que a pessoa está
function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

export default async function middleware(request) {
  const { pathname } = new URL(request.url);

  // A lista de acessos só é lida pela API do painel, nunca como arquivo
  if (pathname === '/data/access.json') return new Response('Not found', { status: 404 });

  if (PUBLIC_PATHS.includes(pathname)) return next();

  const secret = process.env.SESSION_SECRET;
  // Sem segredo configurado, o site fica fechado (falha segura)
  if (!secret || secret.length < 32) {
    return new Response('Acesso não configurado.', { status: 503 });
  }

  const wantsPage = (request.headers.get('accept') || '').includes('text/html');
  const token = readCookie(request, COOKIE_NAME);

  if (token) {
    let session = null;
    try {
      const result = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });
      session = result.payload;
    } catch (err) {
      session = null;
    }

    if (session) {
      const email = String(session.email || '').toLowerCase();
      const cfg = await loadAccess();

      if (cfg.unavailable && !cfg.owners.has(email)) {
        return wantsPage
          ? new Response('Não foi possível conferir as permissões de acesso agora. Tente de novo em instantes.', { status: 503, headers: { 'Cache-Control': 'no-store' } })
          : json(503, { error: 'access_unavailable' });
      }
      if (!canStay(cfg, email)) {
        return wantsPage
          ? new Response('Acesso revogado.', { status: 403, headers: { 'Cache-Control': 'no-store' } })
          : json(403, { error: 'revoked' });
      }
      if (isAdminPath(pathname)) {
        // Primeiro: precisa poder entrar no painel (master ou admin)
        if (!isAdminEmail(cfg, email)) {
          return pathname.startsWith('/api/') ? json(403, { error: 'forbidden' }) : redirect('/');
        }
        // Depois: rotas de master (usuários e logs) exigem master de verdade
        if (isMasterPath(pathname) && !isMaster(cfg, email)) {
          return json(403, { error: 'forbidden_master' });
        }
      }
      return next();
    }
  }

  return wantsPage ? redirect('/login.html') : json(401, { error: 'unauthorized' });
}
