// Entrega ao navegador apenas dados públicos necessários para o botão do Google
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // Só o necessário para o botão do Google. NÃO expõe o domínio permitido:
  // quem está de fora não deve saber quais contas têm acesso (anti-engenharia social).
  res.status(200).json({
    clientId: process.env.GOOGLE_CLIENT_ID || ''
  });
}
