// Exige uma sessão válida (cookie assinado) para entregar qualquer arquivo do site.
// Sem sessão: páginas redirecionam para /login.html e as demais requisições recebem 401.
import { next } from '@vercel/edge';
import { jwtVerify } from 'jose';

export const config = {
  matcher: '/((?!_vercel).*)'
};

// Rotas que precisam ser públicas para o login funcionar
const PUBLIC_PATHS = [
  '/login.html',
  '/privacidade.html',
  '/css/style.css',
  '/css/login.css',
  '/js/login.js',
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

export default async function middleware(request) {
  const { pathname } = new URL(request.url);
  if (PUBLIC_PATHS.includes(pathname)) return next();

  const secret = process.env.SESSION_SECRET;
  // Sem segredo configurado, o site fica fechado (falha segura)
  if (!secret || secret.length < 32) {
    return new Response('Acesso não configurado.', { status: 503 });
  }

  const token = readCookie(request, 'qh_session');
  if (token) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });
      return next();
    } catch (err) {
      // Token inválido ou expirado: cai no bloqueio abaixo
    }
  }

  const wantsPage = (request.headers.get('accept') || '').includes('text/html');
  if (wantsPage) return Response.redirect(new URL('/login.html', request.url), 302);

  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}
