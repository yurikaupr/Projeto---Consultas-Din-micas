/* QueryHub | Login com Google (a validação do domínio acontece no servidor, em /api/login) */
(function () {
  'use strict';

  var errorEl = document.getElementById('loginError');

  function showError(message) { errorEl.textContent = message; }

  function handleCredential(response) {
    showError('');
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    }).then(function (res) {
      if (res.ok) { window.location.replace('/'); return; }
      if (res.status === 403) {
        showError('Esta conta não tem acesso.');
      } else if (res.status === 503) {
        res.json().then(function (d) {
          showError(d && d.error === 'access_unavailable'
            ? 'Não foi possível conferir as permissões agora. Tente de novo em instantes.'
            : 'O acesso ainda não foi configurado no servidor.');
        }).catch(function () { showError('O acesso ainda não foi configurado no servidor.'); });
      } else {
        showError('Não foi possível validar o login. Tente novamente.');
      }
    }).catch(function () {
      showError('Falha de conexão. Tente novamente.');
    });
  }

  function startGoogle(config) {
    if (!window.google || !window.google.accounts) {
      showError('Não foi possível carregar o login do Google. Verifique sua conexão ou bloqueadores de conteúdo.');
      return;
    }
    window.google.accounts.id.initialize({
      client_id: config.clientId,
      callback: handleCredential
    });
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var box = document.getElementById('googleButton');
    window.google.accounts.id.renderButton(box, {
      theme: dark ? 'filled_black' : 'outline',
      size: 'large',
      text: 'signin_with',
      shape: 'rectangular',
      width: Math.max(200, Math.min(320, box.parentNode.clientWidth || 320))
    });
  }

  function waitForGoogle(config, tries) {
    if (window.google && window.google.accounts) { startGoogle(config); return; }
    if (tries <= 0) { startGoogle(config); return; }
    setTimeout(function () { waitForGoogle(config, tries - 1); }, 150);
  }

  fetch('/api/config').then(function (res) {
    if (!res.ok) throw new Error('config');
    return res.json();
  }).then(function (config) {
    if (!config.clientId) { showError('O acesso ainda não foi configurado.'); return; }
    // Mensagem genérica: não revela o domínio/contas que têm acesso
    document.getElementById('loginText').textContent =
      'Acesso restrito. Entre com uma conta autorizada.';
    waitForGoogle(config, 40);
  }).catch(function () {
    showError('Não foi possível iniciar o login agora. Tente novamente em instantes.');
  });
})();
