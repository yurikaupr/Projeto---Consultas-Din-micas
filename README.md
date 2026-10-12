# QueryHub

Biblioteca de consultas dinâmicas do time de Sucesso do Cliente · Magazord.

## Como funciona
- **Time** (`index.html`): entra com Google (`@magazord.com.br`), pesquisa, vê colunas e filtros, baixa os JSONs e pede ajustes por e-mail. Somente leitura.
- **Painel** (`admin.html`): só para quem é **master** ou **admin**. Cadastra, revisa, organiza e publica consultas.
- **Publicar** grava `data/queries.json` no GitHub (um commit por publicação). A Vercel faz o deploy sozinha e o time vê a mudança em ~1 minuto.
- Cada consulta tem um **ID** (#001, #002…), usado na busca, nos links diretos e nos pedidos de ajuste.

## Perfis de acesso
| Perfil | Entra no site | Abre o painel | Publica consultas | Gerencia usuários | Vê logs |
|---|:--:|:--:|:--:|:--:|:--:|
| **master** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **admin** | ✓ | ✓ | ✓ | — | — |
| **viewer** (consulta) | ✓ | — | — | — | — |
| **blocked** | — | — | — | — | — |

- **master** = "master master": faz tudo, inclusive gerenciar quem entra e ler os logs de acesso.
- **admin** = "sobe consulta": usa o painel e publica, mas **não** mexe em usuários nem vê logs.
- Os e-mails em `ADMIN_EMAILS` (Vercel) são **masters fixos** (owners): imutáveis, nunca perdem o acesso. É o lugar recomendado para definir `yuri.klug@magazord.com.br` e `yurikaupr@gmail.com` como masters. Masters adicionais podem ser definidos no painel (perfil "Master").
- No painel, **só o master** vê **Segurança e acesso** (a regra vigente — por padrão "somente contas @magazord.com.br" — e quem tem acesso elevado), **Usuários e permissões** e **Logs de acesso**. O admin comum só vê o cadastro/publicação.
- O servidor **reconfere o perfil e o domínio a cada requisição** (não confia no cookie): mudar a lista vale em até ~1 minuto, inclusive para quem já está logado.

## Estrutura
```
index.html / admin.html     Páginas do time e do administrador
login.html / privacidade.html
css/style.css               Estilos e temas claro/escuro (paleta Magazord)
css/login.css               Estilos do login e da política
js/theme.js                 Tema claro/escuro (carrega antes da página)
js/app.js                   Núcleo: lista, busca, painel de detalhes, pedido de ajuste
js/admin.js                 Só no admin: importação, relatório, edição, publicação, Segurança e Logs
js/access.js                Só no admin: gerência de usuários/acessos (master)
js/login.js                 Login com Google
js/vendor/jszip.min.js      Carregado só quando precisa gerar ou ler ZIP
api/_access.js              Regras de perfil (master/admin/viewer/blocked) e logs
api/_session.js             Sessão, requireAdmin (painel) e requireMaster
api/me.js                   Perfil + capacidades do usuário logado
api/admin/publish.js        Publica consultas (master ou admin)
api/admin/access.js         Gerência de usuários (somente master)
api/admin/status.js         Resumo da política de acesso (painel de Segurança)
api/admin/logs.js           Logs de acesso (somente master)
middleware.js               Exige sessão; /admin exige painel; usuários/logs exigem master
data/queries.json           Biblioteca publicada
data/access.json            Lista de acessos (editada pelo master)
test/access.test.mjs        Testes da matriz de acesso (node)
test/audit.test.mjs         Testes anti-abuso do log (node)
vercel.json                 Cabeçalhos de segurança e cache
```

## Para o time
- **Busca:** nome, ID, descrição e colunas. Atalhos: `coluna:status`, `filtro:data_inicio`, `id:12,34` ou só `12 34`. A tecla `/` foca a busca.
- **Categorias:** dá para marcar várias (qualquer uma ou todas).
- **Link direto:** "Copiar link" no painel de detalhes gera um endereço `#c=ID` que abre a consulta.
- **Pedir ajuste:** abre o e-mail já preenchido para o destinatário definido em `REQUEST_EMAIL` no início de `js/app.js`.
- **Tema:** o botão no topo alterna automático (segue o sistema), claro e escuro. A escolha fica salva no navegador.

## Para o administrador
- **Revisão:** painel de progresso e filtros de pendências (sem descrição, só em "Outros", com aviso). No editor, "Salvar e próxima" percorre a fila.
- **Desfazer:** Ctrl+Z ou o botão na barra de publicação (importações, edições, exclusões e categorias em lote).
- **Publicar:** a barra inferior mostra quantas mudanças faltam publicar; o resumo lista novas, alteradas e removidas.
- **Arrastar arquivos:** solte JSONs ou um ZIP em qualquer lugar da tela.
- O relatório de importação e o guia de mensagens explicam cada erro e aviso.

## Variáveis de ambiente (Vercel > Settings > Environment Variables)
| Variável | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | ID do cliente OAuth do Google |
| `SESSION_SECRET` | texto aleatório com 32+ caracteres |
| `ALLOWED_DOMAIN` | `magazord.com.br` (opcional, é o padrão) |
| `ADMIN_EMAILS` | **masters fixos** (owners), separados por vírgula. Ex.: `yuri.klug@magazord.com.br,yurikaupr@gmail.com`. Imutáveis pelo painel. |
| `GITHUB_TOKEN` | token do GitHub com permissão em Contents (leitura e escrita) |
| `GITHUB_REPO` | `usuario/nome-do-repositorio` |
| `GITHUB_BRANCH` | branch de produção, `main` (opcional) |
| `GITHUB_AUDIT_BRANCH` | opcional: branch onde os **logs** são gravados (padrão `queryhub-audit`). Mantenha-a **diferente** da branch de produção para que registrar logs **não** dispare um redeploy. É criada sozinha na primeira vez. |
| `ACCESS_LOG` | opcional: `off` desliga o registro de logs (padrão: ligado quando o GitHub está configurado) |
| `SESSION_HOURS` | duração do login em horas, de 1 a 24 (padrão 8) |
| `ALLOWED_EMAILS` | opcional: se preenchida, só estes e-mails (e os masters) entram — força o modo "somente lista" |
| `BLOCKED_EMAILS` | opcional: e-mails bloqueados na hora, mesmo com login aberto |
| `EXTRA_ALLOWED_EMAILS` | opcional: e-mails extras só para consulta |

Depois de criar ou alterar variáveis, faça **Redeploy**.

> **Masters:** defina `yuri.klug@magazord.com.br` e `yurikaupr@gmail.com` em `ADMIN_EMAILS` (forma recomendada, imutável). Eles já constam como `master` em `data/access.json` para funcionar desde já; se os colocar em `ADMIN_EMAILS`, **remova-os da lista do painel** para não duplicar (o painel recusa editar um owner com a mensagem "master fixo").

## Segurança (resumo)
- Todo arquivo e rota exige sessão, exceto a tela de login, a política de privacidade, o tema e o CSS do login.
- O domínio é validado no servidor **a cada requisição** (login confere `hd` + e-mail; o acesso contínuo reconfere o domínio/lista). O painel exige master ou admin; **usuários e logs exigem master** — tudo conferido no servidor, nunca pelo cookie.
- Cookie `__Host-` com HttpOnly, Secure e SameSite=Lax. Rotas de escrita também conferem a origem (`Origin`/`Sec-Fetch-Site`).
- CSP restritiva, HSTS (`includeSubDomains`/`preload`), COOP, X-Frame-Options, nosniff e sem referrer. `/data/*` com `no-store`. Nenhum segredo no navegador.
- **Logs de acesso** (login, login negado, publicação, mudança de acessos) ficam em `data/audit-log.json` numa branch separada; só master vê. Nunca guardam token nem conteúdo de consulta.
- Para revogar: `BLOCKED_EMAILS` ou o perfil "Bloqueado" (uma pessoa), ou troque o `SESSION_SECRET` (todos).
- Proteções de abuso: rate limit por IP no `/api/login` (429) e logs gravados em lote (no máx. ~1 commit/20s por instância), para que um flood de logins não gaste a cota do GitHub.
- Testes: `node test/access.test.mjs` (matriz de acesso) e `node test/audit.test.mjs` (anti-abuso do log).
