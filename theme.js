/* QueryHub | Tema claro/escuro
   Carregado no <head>, antes da página, para não piscar o tema errado.
   Modos: "auto" (segue o sistema), "light" e "dark". A escolha fica salva no navegador. */
(function () {
  'use strict';

  var KEY = 'queryhub:theme';
  var root = document.documentElement;
  var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var NEXT = { auto: 'light', light: 'dark', dark: 'auto' };
  var LABEL = {
    auto: 'Tema: automático (segue o sistema). Clique para usar o claro.',
    light: 'Tema: claro. Clique para usar o escuro.',
    dark: 'Tema: escuro. Clique para voltar ao automático.'
  };

  function read() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch (e) { return 'auto'; }
  }

  function write(mode) {
    try { if (mode === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch (e) { /* sem armazenamento: vale só nesta visita */ }
  }

  var mode = read();

  function resolved() { return mode === 'auto' ? (query && query.matches ? 'dark' : 'light') : mode; }

  function apply() {
    var eff = resolved();
    root.setAttribute('data-theme', eff);
    root.setAttribute('data-theme-mode', mode);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', eff === 'dark' ? '#0f141a' : '#ffffff');
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.setAttribute('title', LABEL[mode]);
      b.setAttribute('aria-label', LABEL[mode]);
    });
  }

  apply();

  // Em modo automático, acompanha mudanças do sistema em tempo real
  if (query) {
    var onChange = function () { if (mode === 'auto') apply(); };
    if (query.addEventListener) query.addEventListener('change', onChange); else if (query.addListener) query.addListener(onChange);
  }

  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    mode = NEXT[mode];
    write(mode);
    apply();
  });

  // Se outra aba mudar o tema, esta também muda
  window.addEventListener('storage', function (e) { if (e.key === KEY) { mode = read(); apply(); } });

  window.QHTheme = { get: function () { return mode; }, resolved: resolved };
})();
