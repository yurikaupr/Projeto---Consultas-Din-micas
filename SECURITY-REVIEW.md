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

## 4b. Testes de burla executados ao vivo (resultados reais)

Rodados contra `https://queryhub-nu.vercel.app` em 2026-10-11, sem causar dano.
**Todas as tentativas falharam** — a camada técnica não foi burlável de fora.

| Vetor testado | Tentativa | Resultado |
|---|---|---|
| **Forjar cookie de sessão** | JWT `alg:none` (sem assinatura) | `401` ❌ não passa |
| **Segredo de sessão fraco** | 11 segredos comuns assinando JWT HS256 | `401` em todos ❌ |
| **Acesso sem login ao banco de consultas** | `/data/queries.json` | `401` ❌ |
| **Normalização de path** | `//`, `/./`, `/../`, `%2e`, `%252e`, maiúsculas, `%00`, `;.css`, `#.css`, barra final | `401`/`404`/`400`; o `308` do `//` termina em `401` ❌ |
| **Esconder `access.json`** | variações de encoding/rota | `404`/`401` ❌ |
| **Método HTTP alternativo** | HEAD, OPTIONS, PUT, DELETE, TRACE | `401` (TRACE `405`) ❌ |
| **Open redirect** | `?redirect=`, `?next=https://evil` | ignorado; vai sempre p/ `/login.html` ❌ |
| **Cabeçalhos forjados** | `X-Forwarded-Host`, `X-Forwarded-For`, `Sec-Fetch-Site` falsos | `401` ❌ |
| **CSRF cross-site** | POST login com `Origin: evil.example` | `403 bad_origin` ❌ |
| **Token Google falso** | credential inválido em `/api/login` | `401 invalid_token` ❌ |
| **Vazar código-fonte** | `_session.js`, `_access.js`, `middleware.js`, `.env`, `.git/config` | `401` (não servidos) ❌ |

**Conclusão:** de uma posição não autenticada, o site é, na prática,
**inquebrável** com a tecnologia atual. Não há SQL, não há IDOR, não há XSS
explorável, não há forja de sessão, não há bypass de path.

## 4c. O único caminho que sobra: a conta Google legítima (engenharia social)

Como a porta técnica está fechada, o atacante realista mira a **conta Google**
de alguém que já tem acesso. Isto **não é uma falha de código** — é o limite do
modelo "entre com Google". Não testei isso com pessoas reais (seria phishing de
verdade contra funcionários — fora de qualquer teste ético). A análise:

1. **[ALTO] Qualquer conta `@magazord.com.br` vira "viewer" (modo `domain`).**
   Hoje, basta ter uma conta do domínio para ler **todas** as consultas
   (colunas/estrutura — exatamente o seu medo). Se um funcionário qualquer cair
   num phishing, o atacante lê tudo.
   - **Mitigação forte:** mude para **modo "somente lista"** (variável
     `ALLOWED_EMAILS` na Vercel, ou o modo "lista" no painel admin). Assim só
     e-mails nomeados entram — não "qualquer um do domínio".
   - Exija **2FA/passkey para todos** que acessam (você já tem nas suas contas;
     o elo é quem mais tem acesso).

2. **[ALTO] Comprometer um ADMIN = controle total.** O atacante publicaria
   consultas falsas e mudaria a lista de acessos.
   - Mantenha o conjunto de admins **mínimo** e só com contas corporativas.
   - **Remova o Gmail pessoal do admin** (ver 2.1) — é o alvo mais fácil.
   - Admins com **chave de segurança/passkey** (2FA resistente a phishing).

3. **[MÉDIO] Replay de token / página de login falsa com seu `client_id`.**
   O `client_id` é público (aparece em `/api/config` — inevitável no GIS). O
   servidor fixa o `audience` e o domínio, então um token de conta não
   corporativa não passa. Para fechar de vez:
   - No **Google Cloud Console → Credenciais OAuth**, confirme que *Authorized
     JavaScript origins* / *redirect URIs* estão restritos ao seu domínio (só
     `https://queryhub-nu.vercel.app`). Assim o botão Google só funciona no seu
     site.
   - No **Google Workspace admin**, restrinja apps de terceiros (evita *consent
     phishing* que levaria ao caso 1/2).

4. **[BAIXO] Spear-phishing pelo fluxo "pedir ajuste".** O e-mail
   `yuri.klug@magazord.com.br` fica no código. Impacto baixo; apenas esteja
   ciente de e-mails se passando por esse fluxo.

**Resumo do risco residual:** com a tecnologia atual, invadir "o site" exige
invadir **uma conta Google autorizada**. Os dois passos que mais reduzem isso:
(a) **modo lista** em vez de "qualquer um do domínio"; (b) **2FA/passkey + só
contas corporativas no admin**.

## 5. O que fica como decisão sua (fora do código)
- Tirar o Gmail pessoal do admin / usar `@magazord.com.br` em `ADMIN_EMAILS`.
- Ligar Vercel Firewall + Rate Limiting (resposta ao DDoS/força bruta).
- Manter 2FA em Google Cloud, Vercel e GitHub (já feito).
- Rotacionar `GITHUB_TOKEN` e `SESSION_SECRET` periodicamente.

---

## 6. Atualização: dois níveis de admin + endurecimento (commit atual)

### 6.1 Perfis (RBAC)
Agora há quatro perfis, conferidos **no servidor a cada requisição**:

| Perfil | Site | Painel | Publica | Usuários | Logs |
|---|:--:|:--:|:--:|:--:|:--:|
| **master** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **admin** | ✓ | ✓ | ✓ | — | — |
| **viewer** | ✓ | — | — | — | — |
| **blocked** | — | — | — | — | — |

- **master** ("master master"): tudo, inclusive gerenciar quem entra e ler os logs.
- **admin** ("sobe consulta"): painel + publicar; **sem** acesso a usuários ou logs.
- `yuri.klug@magazord.com.br` e `yurikaupr@gmail.com` são masters (recomenda-se `ADMIN_EMAILS`, que são owners imutáveis).

### 6.2 Como a separação é garantida (defesa em camadas)
1. `middleware.js` (Edge): `/admin.html` e `/api/admin/publish` exigem master **ou** admin; `/api/admin/access` e `/api/admin/logs` exigem **master** (`isMasterPath` + `isMaster`).
2. Cada rota reconfere: `requireAdmin` (painel) em `publish`/`status`; `requireMaster` em `access`/`logs`.
3. O cliente só **esconde** botões por capacidade (`/api/me`); quem forjar o DOM/console ainda bate na checagem do servidor.
4. O perfil vem sempre da lista no servidor — **nunca** do cookie/JWT.

### 6.3 Garantia do domínio (a "certeza" pedida)
- Login: só passa com `email_verified`, `hd` == domínio **e** e-mail terminando em `@magazord.com.br` (ou quem estiver explicitamente na lista). Qualquer outra conta Google é recusada.
- **Endurecimento novo:** `canStay` passou a **reconferir o domínio/lista a cada requisição**. Antes, no modo "empresa", uma sessão sobrevivia mesmo após a pessoa sair da lista; agora um parceiro externo removido perde o acesso em ~45s.
- Painel **Segurança e acesso** (`/api/admin/status`) mostra, para qualquer admin, a regra vigente, o domínio, quem é master/admin e as garantias ativas — é o lugar para ter a certeza.

### 6.4 Logs de acesso (somente master)
- Eventos: `login_ok`, `login_denied`, `publish_ok`, `access_updated`. Nunca token nem conteúdo de consulta; guardam e-mail, perfil, detalhe, IP e horário.
- Gravados em `data/audit-log.json` numa **branch separada** (`GITHUB_AUDIT_BRANCH`, padrão `queryhub-audit`) para **não** disparar redeploy a cada evento. Limitado a 500 entradas. Desligável com `ACCESS_LOG=off`.

### 6.5 Prova automatizada
`node test/access.test.mjs` — **57 verificações** da matriz de acesso (quem é master, quem é admin, quem entra, domínio falso/hd falso/não verificado negados, modo lista, falha fechada e a separação master × admin nas rotas). Todas passam.

### 6.6 Teste ao vivo após deploy
Depois do deploy, confirme a separação (com a sessão de um **admin** que não seja master):
```bash
# admin logado: deve publicar, mas ser barrado em usuários e logs
curl -s -o /dev/null -w '%{http_code}\n' -H "Cookie: $QH_COOKIE" https://queryhub-nu.vercel.app/api/admin/access   # espere 403
curl -s -o /dev/null -w '%{http_code}\n' -H "Cookie: $QH_COOKIE" https://queryhub-nu.vercel.app/api/admin/logs     # espere 403
curl -s -o /dev/null -w '%{http_code}\n' -H "Cookie: $QH_COOKIE" https://queryhub-nu.vercel.app/api/admin/status   # espere 200
```
