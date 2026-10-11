# Revisão de Segurança — QueryHub

Data: 2026-10-11 · Escopo: código do repositório + configuração Vercel
Site: https://queryhub-nu.vercel.app/

> Resumo: a arquitetura de autenticação/autorização está **bem construída** e
> fecha os ataques que você citou (login forçado, acesso sem sessão, troca de
> papel pelo console, token Google forjado). Apliquei um conjunto de melhorias
> de reforço (hardening) e deixei um script para você confirmar tudo ao vivo.
> **SQL Injection e DDoS não se aplicam/não devem ser simulados** — explico no fim.

---

## 1. O que já está correto (e por quê os ataques citados falham)

| Ataque que você temia | Por que não funciona |
|---|---|
| Entrar sem ser do escopo | O token do Google é validado **no servidor** (`api/login.js`): assinatura via JWKS do Google, emissor, validade **e** `audience` = seu `GOOGLE_CLIENT_ID`. Um token forjado ou de outro app é rejeitado. |
| "Forçar" login pelo console do navegador | O login só cria sessão se o servidor validar o token. O cookie de sessão é um **JWT assinado** (`HS256`, chave só no servidor). Alterar o cookie no console invalida a assinatura → sessão nula. |
| Virar admin mexendo no cookie/JS | O papel (`role`) **não é lido do cookie** para autorizar. A cada requisição o servidor reconsulta a lista de acessos (`loadAccess`) e decide admin/viewer/bloqueado. Editar o `role` no token não dá poder nenhum. |
| Abrir `/admin` ou `/api/admin/*` sem ser admin | Bloqueado em duas camadas: no `middleware.js` (Edge, antes de servir) e de novo em `requireAdmin` dentro das rotas. |
| Pegar o `data/queries.json` (colunas/SQL) sem login | O `middleware.js` exige sessão para **tudo**, menos a tela de login/CSS/tema. `queries.json` não está na lista pública → sem sessão, 401/redirect. `data/access.json` é forçado a **404**. |
| Expiração/roubo de sessão | Cookie `__Host-qh_session`: `HttpOnly` (JS não lê), `Secure` (só HTTPS), `SameSite=Lax`, `Path=/`, sem `Domain`. Expira em `SESSION_HOURS` (1–24). Revogação por `BLOCKED_EMAILS` ou trocando `SESSION_SECRET`. |
| alg confusion / `alg:none` no JWT | O verify fixa `algorithms: ['HS256']`. Não aceita `none` nem troca de algoritmo. |
| XSS (injetar HTML pelas consultas) | Todo dado dinâmico passa por `esc()` antes de virar HTML. A CSP **não permite** `'unsafe-inline'` em `script-src`, então script injetado não executa. |
| Clickjacking | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`. |
| Falha de configuração abrindo o site | **Fail-closed**: sem `SESSION_SECRET` (≥32 chars) → 503; sem conseguir ler a lista de acessos → só os admins fixos entram. |

Outras boas práticas já presentes: repositório privado, `robots.txt` bloqueando
tudo + `X-Robots-Tag noindex`, proteção contra *zip bomb* (`maxOutputLength`),
limites (`MAX_QUERIES`, `MAX_USERS`), *optimistic locking* (`sha`) nas gravações
no GitHub, e nenhum segredo exposto ao navegador (`/api/config` só devolve o
`clientId` público e o domínio).

---

## 2. Achados e recomendações

### 2.1 [MÉDIO] Admin usando conta Gmail pessoal — risco de conta
`data/access.json` lista `yurikaupr@gmail.com` como **admin**. É uma conta
pessoal, fora do domínio corporativo, com poder total (publicar consultas e
alterar a lista de acessos). Se esse Gmail for comprometido, o site é
comprometido — independentemente de o código estar perfeito.

**Ação (sua, não é código):**
- Prefira admins **`@magazord.com.br`**, definidos em `ADMIN_EMAILS` na Vercel
  (admins fixos, "owners", que o painel não consegue rebaixar).
- Garanta 2FA nessa conta (você disse que já tem — ótimo; mantenha).
- Se o Gmail for só para testes, remova-o do admin em produção.

### 2.2 [BAIXO-MÉDIO] Sem rate limiting na aplicação → resposta correta para "DDoS"
Não há *rate limiting* em `/api/login` e `/api/admin/*`. O impacto é limitado
(login exige token Google válido; admin exige sessão+admin), mas é aqui que mora
a sua preocupação com **DDoS/força bruta**.

**A forma certa de "testar DDoS" é configuração, não simular um ataque:**
- Ligue o **Vercel Firewall / Attack Challenge Mode** (Project → Firewall).
- Crie **Rate Limiting rules** para `/api/*` (ex.: 60 req/min por IP).
- Considere **Vercel WAF** managed rules.
Simular um flood só confirmaria o óbvio (tráfego suficiente derruba qualquer
servidor) e poderia te gerar custo/instabilidade — não revela vulnerabilidade.

### 2.3 [BAIXO] CSRF — já mitigado, reforçado
Já havia `SameSite=Lax` (navegador não envia o cookie em POST cross-site) +
checagem de origem (`sameOrigin`). **Reforcei** `sameOrigin` para **recusar**
requisições que não tragam *nem* `Origin` *nem* `Sec-Fetch-Site` (o navegador
sempre envia `Sec-Fetch-Site` em `fetch()` do próprio site; a página não
consegue forjá-lo). Mudança segura, não afeta o login.

### 2.4 [BAIXO] Hardening de cabeçalhos (aplicado em `vercel.json`)
- `Strict-Transport-Security`: agora `max-age=63072000; includeSubDomains; preload`.
- **Novo** `Cross-Origin-Opener-Policy: same-origin-allow-popups` (valor seguro
  para o login Google).
- **Novo** `X-Permitted-Cross-Domain-Policies: none`.
- `Permissions-Policy` ampliada (bloqueia câmera, mic, geoloc, USB, etc.).
- Cache de `/data/*` passou de `private, no-cache` para **`no-store`** (o
  `queries.json` não fica em cache de disco do navegador/intermediários).

### 2.5 [INFO] SQL Injection **não se aplica a este projeto**
Não existe banco de dados nem SQL executado em runtime. As "consultas" são
**JSON estático** (`data/queries.json`) servido apenas a usuários autenticados.
O SQL que vive dentro de `raw_json` **nunca é executado pelo site** — é só texto
para o time baixar. Portanto **não há superfície de SQL injection**. O risco
equivalente e real é o **vazamento do `queries.json`** (as colunas/estrutura),
que já está protegido por sessão — confirme com o teste 2 do script.

### 2.6 [INFO] Observações menores
- `privacidade.html` carrega `theme.js`/CSS sem `?v=` — cosmético, sem impacto
  de segurança.
- Mensagens de erro de configuração (503) revelam estado de setup — baixíssimo
  impacto; mantidas por serem úteis em operação.

---

## 3. Hardening aplicado neste commit

- `vercel.json`: HSTS reforçado, COOP, X-Permitted-Cross-Domain-Policies,
  Permissions-Policy ampliada, `/data/*` com `no-store`.
- `api/_session.js`: `sameOrigin()` recusa requisições sem `Origin` e sem
  `Sec-Fetch-Site`.

Depois de dar *merge*/deploy, faça **Redeploy** na Vercel para os headers valerem.

---

## 4. Como testar ao vivo (não-destrutivo)

Use o script `pentest.sh` deste repositório **do seu computador** (ele precisa
de internet até o site). Ele verifica, sem causar dano:

1. Cabeçalhos de segurança em produção.
2. **`/data/queries.json` sem sessão → tem de negar** (o teste decisivo).
3. `/data/access.json → 404`.
4. `/admin.html` e `/` sem sessão → redirecionam para login.
5. `/api/me` e `/api/admin/access` sem sessão → 401.
6. CSRF: POST com `Origin` falso → `bad_origin`.
7. Exposição de código-fonte (`/api/_session.js`, `/middleware.js`) → 404.
8. Confere que a sessão está marcada corretamente se você colar seu cookie.

```bash
bash pentest.sh https://queryhub-nu.vercel.app
```

Para o item 8 (checar sua própria sessão), faça login no site, copie o cookie
`__Host-qh_session` (DevTools → Application → Cookies) e rode:

```bash
QH_COOKIE='__Host-qh_session=SEU_TOKEN_AQUI' bash pentest.sh https://queryhub-nu.vercel.app
```

---

## 5. O que fica como decisão sua (fora do código)
- Tirar o Gmail pessoal do admin / usar `@magazord.com.br` em `ADMIN_EMAILS`.
- Ligar Vercel Firewall + Rate Limiting (resposta ao DDoS/força bruta).
- Manter 2FA em Google Cloud, Vercel e GitHub (já feito).
- Rotacionar `GITHUB_TOKEN` e `SESSION_SECRET` periodicamente.
