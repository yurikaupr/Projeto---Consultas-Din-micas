// Entrega ao navegador apenas dados públicos necessários para o botão do Google
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    domain: (process.env.ALLOWED_DOMAIN || 'magazord.com.br').toLowerCase()
  });
}
