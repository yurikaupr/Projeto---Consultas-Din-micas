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
| `EXTRA_ALLOWED_EMAILS` | e-mails extras só para consulta (opcional) |

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
