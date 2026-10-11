/* QueryHub | Tema claro/escuro
   Carregado no <head>, antes da página, para não piscar o tema errado.
   Modos: "auto" (segue o sistema), "light" e "dark". A escolha fica salva no navegador. */
(function () {
  'use strict';

  var BUILD = '3.4.0';
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

  /* ---- Conferência de versão: avisa se alguma peça do site ficou antiga ---- */
  var seen = {};
  window.QHBuild = { expected: BUILD, report: function (name, v) { seen[name] = v; } };

  function checkBuild() {
    var bad = [];
    var css = (getComputedStyle(root).getPropertyValue('--qh-build') || '').replace(/["'\s]/g, '');
    if (css !== BUILD) bad.push('css/style.css (' + (css ? 'versão ' + css : 'antigo ou não carregou') + ')');
    if (root.getAttribute('data-build') !== BUILD) bad.push('a página HTML (' + (root.getAttribute('data-build') ? 'versão ' + root.getAttribute('data-build') : 'antiga') + ')');
    ['app', 'admin', 'access', 'login'].forEach(function (name) {
      if (document.querySelector('script[src*="js/' + name + '.js"]') && name !== 'login' && seen[name] !== BUILD) {
        bad.push('js/' + name + '.js (' + (seen[name] ? 'versão ' + seen[name] : 'antigo ou não carregou') + ')');
      }
    });
    if (!bad.length) return;
    var bar = document.createElement('div');
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:12px 16px;background:#b42318;color:#fff;font:600 13px/1.5 system-ui,sans-serif;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    bar.textContent = 'Parte do site está desatualizada neste navegador: ' + bad.join(', ') + '. Aperte Ctrl+F5. Se continuar assim, confira se esses arquivos estão nas pastas certas no GitHub (css/ e js/). Versão esperada: ' + BUILD + '.';
    var close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Fechar aviso');
    close.style.cssText = 'margin-left:12px;border:0;background:transparent;color:#fff;font-size:18px;cursor:pointer';
    close.onclick = function () { bar.remove(); };
    bar.appendChild(close);
    document.body.appendChild(bar);
  }
  window.addEventListener('load', function () { setTimeout(checkBuild, 300); });

  window.QHTheme = { get: function () { return mode; }, resolved: resolved };
})();
