# QueryHub

Biblioteca de consultas dinâmicas do time de Sucesso do Cliente · Magazord.

## Estrutura
```
index.html              Aplicação
login.html              Tela de login com Google
css/style.css           Estilos (paleta Magazord)
css/login.css           Estilos do login
js/app.js               Lógica da biblioteca
js/login.js             Lógica do login
api/                    Funções do servidor (validação do Google e sessão)
middleware.js           Bloqueia o site para quem não tem sessão válida
data/queries.json       Biblioteca compartilhada (de preferência criptografada)
vercel.json             Cabeçalhos de segurança
```

## 1. Criar o login no Google Cloud
1. Acesse https://console.cloud.google.com e crie um projeto (ex.: "QueryHub").
2. Abra **APIs e serviços > Tela de consentimento OAuth** (ou "Google Auth Platform").
   - Tipo de usuário: **Externo**. Informe o nome do app e seu e-mail de suporte.
   - Escopos: apenas os básicos (openid, e-mail e perfil).
   - Em **Status de publicação**, clique em **Publicar app**. Em "Teste", só entram e-mails cadastrados manualmente.
3. Abra **Credenciais > Criar credenciais > ID do cliente OAuth** e escolha **Aplicativo da Web**.
   - Origens JavaScript autorizadas: `https://SEU-PROJETO.vercel.app` (e `http://localhost:3000` para testes locais).
   - Não precisa de URI de redirecionamento.
4. Copie o **ID do cliente**.

## 2. Publicar na Vercel
1. Suba este projeto em um repositório **privado** do GitHub.
2. Na Vercel: **Add New > Project**, importe o repositório (Framework Preset: Other).
3. Em **Environment Variables**, crie:

| Variável | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | ID do cliente copiado do Google |
| `SESSION_SECRET` | texto aleatório com 32+ caracteres (ex.: `openssl rand -base64 48`) |
| `ALLOWED_DOMAIN` | `magazord.com.br` (opcional, é o padrão) |
| `EXTRA_ALLOWED_EMAILS` | e-mails extras liberados, separados por vírgula (opcional) |

4. Faça o deploy. Depois de criar o domínio final, volte ao Google Cloud e confira se a origem autorizada é exatamente o endereço do site.

## 3. Testar
- Aba anônima: abrir o site deve levar à tela de login.
- Conta `@magazord.com.br`: entra.
- Conta Gmail pessoal: recebe "Esta conta não tem acesso".
- `https://SEU-SITE/data/queries.json` sem login: não pode devolver o arquivo.

## Atualizar a biblioteca do time
1. No app, **Exportar** e informe uma senha de proteção.
2. Substitua `data/queries.json` pelo arquivo gerado e faça o deploy.
3. Os analistas clicam em **Sincronizar** e digitam a senha da biblioteca.
