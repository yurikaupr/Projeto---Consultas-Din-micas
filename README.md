# QueryHub

Biblioteca de consultas dinâmicas do time de Sucesso do Cliente · Magazord.

## Como funciona
- **Time** (`index.html`): entra com Google (`@magazord.com.br`), pesquisa, vê colunas e filtros, baixa os JSONs e pede ajustes por e-mail. Somente leitura.
- **Admin** (`admin.html`): só e-mails em `ADMIN_EMAILS`. Cadastra, revisa e organiza as consultas e publica.
- **Publicar** grava `data/queries.json` no GitHub (um commit por publicação). A Vercel faz o deploy sozinha e o time vê a mudança em ~1 minuto.
- Cada consulta tem um **ID** (#001, #002…), usado na busca, nos links diretos e nos pedidos de ajuste.

## Estrutura
```
index.html / admin.html     Páginas do time e do administrador
login.html / privacidade.html
css/style.css               Estilos e temas claro/escuro (paleta Magazord)
css/login.css               Estilos do login e da política
js/theme.js                 Tema claro/escuro (carrega antes da página)
js/app.js                   Núcleo: lista, busca, painel de detalhes, pedido de ajuste
js/admin.js                 Só no admin: importação, relatório, edição, desfazer, publicação
js/login.js                 Login com Google
js/vendor/jszip.min.js      Carregado só quando precisa gerar ou ler ZIP
api/                        Login, sessão e publicação (servidor)
middleware.js               Bloqueia o site sem sessão e o /admin sem perfil de admin
data/queries.json           Biblioteca publicada
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
| `ADMIN_EMAILS` | e-mails dos administradores, separados por vírgula |
| `GITHUB_TOKEN` | token do GitHub com permissão em Contents (leitura e escrita) |
| `GITHUB_REPO` | `usuario/nome-do-repositorio` |
| `GITHUB_BRANCH` | `main` (opcional) |
| `SESSION_HOURS` | duração do login em horas, de 1 a 24 (padrão 8) |
| `ALLOWED_EMAILS` | opcional: se preenchida, só estes e-mails (e os admins) entram |
| `BLOCKED_EMAILS` | opcional: e-mails bloqueados na hora, mesmo com login aberto |
| `EXTRA_ALLOWED_EMAILS` | opcional: e-mails extras só para consulta |

Depois de criar ou alterar variáveis, faça **Redeploy**.

## Segurança (resumo)
- Todo arquivo e rota exige sessão, exceto a tela de login, a política de privacidade, o tema e o CSS do login.
- O domínio é validado no servidor. O painel admin e a publicação exigem o e-mail em `ADMIN_EMAILS`, conferido a cada requisição.
- Cookie `__Host-` com HttpOnly, Secure e SameSite=Lax. Rotas de escrita também conferem a origem.
- CSP restritiva, HSTS, X-Frame-Options, nosniff e sem referrer. Nenhum segredo no navegador.
- Para revogar: `BLOCKED_EMAILS` (uma pessoa) ou troque o `SESSION_SECRET` (todos).
