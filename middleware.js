// Exige uma sessão válida (cookie assinado) para entregar qualquer arquivo do site.
// Sem sessão: páginas redirecionam para /login.html e as demais requisições recebem 401.
// O painel admin (/admin.html e /api/admin/*) exige perfil de administrador.
import { next } from '@vercel/edge';
import { jwtVerify } from 'jose';

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

function listFromEnv(name) {
  return (process.env[name] || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function isAdminPath(pathname) {
  return pathname === '/admin.html' || pathname === '/admin' || pathname.startsWith('/api/admin/');
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

// Regras conferidas a cada requisição, para que mudanças nas variáveis valham na hora
function isStillAllowed(email) {
  if (listFromEnv('BLOCKED_EMAILS').includes(email)) return false;
  const allowList = listFromEnv('ALLOWED_EMAILS');
  if (!allowList.length) return true;
  return allowList.includes(email) ||
    listFromEnv('ADMIN_EMAILS').includes(email) ||
    listFromEnv('EXTRA_ALLOWED_EMAILS').includes(email);
}

export default async function middleware(request) {
  const { pathname } = new URL(request.url);
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

      if (!isStillAllowed(email)) {
        return wantsPage
          ? new Response('Acesso revogado.', { status: 403, headers: { 'Cache-Control': 'no-store' } })
          : json(403, { error: 'revoked' });
      }

      const isAdmin = session.role === 'admin' && listFromEnv('ADMIN_EMAILS').includes(email);
      if (isAdminPath(pathname) && !isAdmin) {
        return pathname.startsWith('/api/') ? json(403, { error: 'forbidden' }) : redirect('/');
      }
      return next();
    }
  }

  return wantsPage ? redirect('/login.html') : json(401, { error: 'unauthorized' });
}
