# QueryHub

Biblioteca de consultas dinâmicas do time de Sucesso do Cliente · Magazord.

## Como funciona
- **Time** (`index.html`): entra com Google (`@magazord.com.br`), pesquisa, vê colunas e baixa os JSONs. Somente leitura.
- **Admin** (`admin.html`): só e-mails em `ADMIN_EMAILS`. Cadastra e edita consultas e clica em **Publicar**.
- **Publicar** grava `data/queries.json` no GitHub (um commit por publicação). A Vercel faz o deploy sozinha e o time vê a mudança em ~1 minuto.
- O histórico de commits do GitHub é o histórico (e o backup) da biblioteca.

## Estrutura
```
index.html / admin.html     Páginas do time e do administrador
login.html / privacidade.html
css/                        Estilos (paleta Magazord)
js/app.js, js/login.js      Lógica
api/                        login, sessão e publicação (servidor)
middleware.js               Bloqueia o site sem sessão e o /admin sem perfil de admin
data/queries.json           Biblioteca publicada
vercel.json                 Cabeçalhos de segurança
```

## Variáveis de ambiente (Vercel > Settings > Environment Variables)
| Variável | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | ID do cliente OAuth do Google |
| `SESSION_SECRET` | texto aleatório com 32+ caracteres |
| `ALLOWED_DOMAIN` | `magazord.com.br` (opcional, é o padrão) |
| `ADMIN_EMAILS` | e-mails dos administradores, separados por vírgula |
| `GITHUB_TOKEN` | token do GitHub (veja abaixo) |
| `GITHUB_REPO` | `usuario/nome-do-repositorio` |
| `GITHUB_BRANCH` | `main` (opcional) |
| `SESSION_HOURS` | duração do login em horas, de 1 a 24 (padrão 8) |
| `ALLOWED_EMAILS` | opcional: se preenchida, só estes e-mails (e os admins) entram, em vez do domínio inteiro |
| `BLOCKED_EMAILS` | opcional: e-mails bloqueados na hora, mesmo com login aberto |
| `EXTRA_ALLOWED_EMAILS` | opcional: e-mails extras só para consulta |

Depois de criar ou alterar variáveis, faça **Redeploy**.

## Criar o token do GitHub
1. GitHub > foto de perfil > **Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token**.
2. Resource owner: sua conta. **Repository access: Only select repositories** e escolha apenas o repositório do QueryHub.
3. Em **Permissions > Repository permissions**, defina **Contents: Read and write**. Nenhuma outra permissão.
4. Defina uma validade (ex.: 90 dias) e anote a data para renovar.
5. Copie o token (começa com `github_pat_`) e cole só na Vercel, em `GITHUB_TOKEN`. Nunca no código nem no GitHub.

## Testar
- Aba anônima: abrir o site leva ao login.
- Conta de administrador: aparece o botão "Painel admin" no topo.
- Conta comum `@magazord.com.br`: entra, mas `/admin.html` volta para a página inicial.
- No admin: cadastre uma consulta, clique em **Publicar**, confira o novo commit no GitHub e, após o deploy, veja a consulta na página do time.

## Observações
- Cada publicação gera um deploy. O plano gratuito da Vercel limita a quantidade de deploys por dia, então faça várias alterações e publique uma vez.
- As alterações ficam em rascunho no navegador do admin até a publicação. "Descartar rascunho" recarrega o que está publicado.
- As favoritas de cada pessoa ficam só no navegador dela.

## Segurança (resumo)
- Todo arquivo e rota exige sessão, exceto a tela de login, a política de privacidade e o CSS do login. O que é sensível (`data/queries.json`, `js/app.js`, `admin.html`, `/api/admin/*`) só é entregue com sessão válida.
- O domínio é validado no servidor (assinatura do token do Google, público-alvo, `email_verified` e campo `hd`). Nada depende do navegador.
- O painel admin e a publicação exigem o e-mail em `ADMIN_EMAILS`, conferido a cada requisição.
- Cookie `__Host-` com HttpOnly, Secure e SameSite=Lax. Rotas de escrita também conferem a origem da requisição.
- Cabeçalhos: CSP restritiva, HSTS, X-Frame-Options, nosniff, sem referrer. A biblioteca JSZip é servida pelo próprio projeto.
- Nenhum segredo está no código do navegador. Os segredos ficam nas variáveis de ambiente da Vercel.
- Logins, bloqueios e publicações são registrados nos logs da Vercel (sem tokens e sem o conteúdo das consultas).

### Revogar acesso
- Uma pessoa: coloque o e-mail em `BLOCKED_EMAILS` e faça Redeploy. O bloqueio vale na hora, mesmo com sessão aberta.
- Todo mundo: troque o `SESSION_SECRET` e faça Redeploy. Todas as sessões deixam de valer.

### Boas práticas
- Ative a verificação em duas etapas no GitHub e na Vercel.
- Mantenha o repositório privado e com poucos colaboradores.
- Use token do GitHub com validade curta, só no repositório do QueryHub, com permissão apenas em Contents.
- Nunca envie `.env` ou tokens para o repositório.
