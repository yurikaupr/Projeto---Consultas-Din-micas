/* ==========================================================================
   QueryHub | Núcleo (usado pelo time e pelo painel admin)
   O painel admin acrescenta recursos em js/admin.js, usando window.QH.
   ========================================================================== */
(function () {
  'use strict';

  if (window.QHBuild) window.QHBuild.report('app', '3.4.0');

  /* ---------- Configurações ---------- */
  var ADMIN = document.body.getAttribute('data-mode') === 'admin';
  var DATA_URL = 'data/queries.json';
  var FAV_KEY = 'queryhub:favorites:v1';
  var REQUEST_EMAIL = 'yuri.klug@magazord.com.br';   // quem recebe os pedidos de ajuste
  var MAILTO_LIMIT = 1900;                            // tamanho máximo do link de e-mail (alguns programas cortam acima disso)
  var MAX_CATEGORIES = 3;
  var MAX_HIGHLIGHTS = 4;
  var PER_PAGE = 20;                                  // consultas por página
  var NEW_DAYS = 7;
  var INK = '#17202a';

  /* Cada categoria tem a cor da marca e uma cor de texto que garante contraste mínimo de 4,5 */
  var CATEGORIES = [
    { name: 'Clientes',    color: '#2754d7', fg: '#ffffff' },
    { name: 'Pedidos',     color: '#ee6757', fg: INK },
    { name: 'Faturamento', color: '#3aae2d', fg: INK },
    { name: 'Marketplace', color: '#7a4fc4', fg: '#ffffff' },
    { name: 'Financeiro',  color: '#1a9a8f', fg: INK },
    { name: 'Produtos',    color: '#d9a400', fg: INK },
    { name: 'Estoque',     color: '#f08a2c', fg: INK },
    { name: 'Preço',       color: '#7fae1b', fg: INK },
    { name: 'Outros',      color: '#8a94a0', fg: INK }
  ];

  /* ---------- Estado ---------- */
  var state = {
    queries: [],
    favs: {},           // id -> true (só no navegador de cada pessoa)
    search: '',
    sq: null,           // busca já interpretada
    cats: {},           // categorias selecionadas
    catMode: 'any',     // any = qualquer uma | all = todas
    onlyFav: false,
    sort: 'name',
    review: '',         // filtro de revisão (admin)
    selected: {},
    openId: null,
    view: [],           // consultas da lista atual, já filtradas e ordenadas (todas as páginas)
    page: 1,            // página atual da lista
    counts: { all: 0, fav: 0, byCat: {} },
    loaded: false,
    user: null,
    request: null       // consulta do pedido de ajuste aberto
  };

  var QH = window.QH = { ADMIN: ADMIN, state: state, CATEGORIES: CATEGORIES, REQUEST_EMAIL: REQUEST_EMAIL, MAX_CATEGORIES: MAX_CATEGORIES, MAX_HIGHLIGHTS: MAX_HIGHLIGHTS, hooks: {} };

  /* ---------- Utilitários ---------- */
  function $(id) { return document.getElementById(id); }

  function on(id, evt, fn) {
    var el = $(id);
    if (el) el.addEventListener(evt, fn);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c];
    });
  }

  function normalize(text) {
    return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function slug(text) {
    return normalize(text).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'consulta';
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function categoryOf(name) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].name === name) return CATEGORIES[i];
    return CATEGORIES[CATEGORIES.length - 1];
  }

  function formatId(n) { return '#' + String(n).padStart(3, '0'); }

  function findQuery(id) {
    for (var i = 0; i < state.queries.length; i++) if (state.queries[i].id === id) return state.queries[i];
    return undefined;
  }

  function selectedIds() { return Object.keys(state.selected); }

  function download(filename, content, mime) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'application/json' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 500);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy')); } catch (err) { reject(err); }
      ta.remove();
    });
  }

  /* ---------- Aviso (toast), com ação opcional ---------- */
  var toastTimer;
  function toast(message, opts) {
    opts = opts || {};
    var el = $('toast'), txt = $('toastText'), act = $('toastAction');
    txt.textContent = message;
    if (opts.action && opts.onAction) {
      act.textContent = opts.action;
      act.classList.remove('hidden');
      act.onclick = function () { el.classList.remove('is-visible'); opts.onAction(); };
    } else {
      act.classList.add('hidden');
      act.onclick = null;
    }
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, opts.ms || (opts.action ? 9000 : 4200));
  }

  /* ---------- Pop-ups com animação de entrada e saída ---------- */
  function openModal(dlg) {
    dlg._closing = false;                 // cancela um fechamento em andamento
    dlg.classList.remove('is-closing');
    if (!dlg.open) dlg.showModal();
  }

  function closeModal(dlg) {
    if (!dlg || !dlg.open || dlg._closing) return;
    if (dlg._beforeClose && dlg._beforeClose() === false) return;   // ex.: alterações não salvas
    if (reducedMotion()) { dlg.close(); return; }
    dlg._closing = true;
    dlg.classList.add('is-closing');
    var done = function () {
      if (!dlg._closing) return;          // foi reaberto no meio da animação
      dlg._closing = false;
      dlg.classList.remove('is-closing');
      if (dlg.open) dlg.close();
    };
    dlg.addEventListener('animationend', function handler(e) {
      if (e.target !== dlg) return;
      dlg.removeEventListener('animationend', handler);
      done();
    });
    setTimeout(done, 360);
  }

  /* ---------- Biblioteca ---------- */
  function fetchLibrary() {
    return fetch(DATA_URL, { cache: 'no-cache' }).then(function (res) {
      if (res.status === 401) { window.location.replace('/login.html'); throw new Error('Sessão expirada.'); }
      if (!res.ok) throw new Error('Não foi possível carregar a biblioteca.');
      return res.json();
    }).then(function (data) { return Array.isArray(data) ? data : []; });
  }

  function loadUser() {
    fetch('/api/me', { cache: 'no-store' }).then(function (res) {
      if (res.status === 401) { window.location.replace('/login.html'); return null; }
      return res.ok ? res.json() : null;
    }).then(function (user) {
      if (!user) return;
      // Painel exige master OU admin (canPanel). Quem não tem volta para o time.
      if (ADMIN && !user.canPanel) { window.location.replace('/'); return; }
      state.user = user;
      $('userEmail').textContent = user.email;
      $('userBox').classList.remove('hidden');
      var adminLink = $('adminLink');
      if (adminLink && user.canPanel) adminLink.classList.remove('hidden');
      if (QH.hooks.user) QH.hooks.user(user);
    }).catch(function () { /* sem /api (ex.: Live Server): segue sem mostrar o usuário */ });
  }

  function logout() {
    fetch('/api/logout', { method: 'POST' }).finally(function () { window.location.replace('/login.html'); });
  }

  /* ---------- Favoritas (somente no navegador de cada pessoa) ---------- */
  function loadFavs() {
    try { state.favs = JSON.parse(localStorage.getItem(FAV_KEY) || '{}') || {}; } catch (err) { state.favs = {}; }
  }

  function toggleFav(id) {
    if (state.favs[id]) delete state.favs[id]; else state.favs[id] = true;
    try { localStorage.setItem(FAV_KEY, JSON.stringify(state.favs)); } catch (err) { /* sem espaço: ignora */ }
    var on = !!state.favs[id];
    var btn = document.querySelector('.query-card[data-id="' + cssEsc(id) + '"] [data-action="fav"]');
    if (btn) { btn.classList.toggle('is-on', on); btn.textContent = on ? '★' : '☆'; }
    if (state.openId === id) updateFavButton();
    recount();
    renderChips();
    if (state.onlyFav) renderList();
  }

  function cssEsc(v) { return (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/"/g, '\\"'); }

  /* ---------- Busca: índice em cache e sintaxe avançada ---------- */
  var indexCache = new WeakMap();

  function getIndex(q) {
    var ix = indexCache.get(q);
    if (ix) return ix;
    var cols = (q.columns || []).map(function (c) { return normalize(c.name + ' ' + c.label); });
    var fils = (q.required_filters || []).map(function (f) { return normalize(f.name + ' ' + f.label); });
    var head = normalize([q.name, q.description, (q.categories || []).join(' '), q.num ? '#' + q.num : '', q.source_filename].join(' '));
    ix = { head: head, cols: cols, fils: fils, all: head + ' ' + cols.join(' ') + ' ' + fils.join(' ') };
    indexCache.set(q, ix);
    return ix;
  }

  function invalidate(q) { indexCache.delete(q); }

  function parseSearch(raw) {
    var s = { terms: [], cols: [], fils: [], ids: null, cat: [], active: false };
    var text = String(raw || '').trim();
    if (!text) return s;
    s.active = true;
    if (/^(#?\d+[\s,;]*)+$/.test(text)) { s.ids = (text.match(/\d+/g) || []).map(Number); return s; }
    var tokens = text.match(/(?:[^\s":]+:)?"[^"]*"|\S+/g) || [];
    tokens.forEach(function (t) {
      var m = t.match(/^(coluna|col|filtro|id|cat|categoria):(.*)$/i);
      if (m) {
        var key = m[1].toLowerCase(), val = m[2].replace(/^"|"$/g, '').trim();
        if (!val) return;
        if (key === 'coluna' || key === 'col') s.cols.push(normalize(val));
        else if (key === 'filtro') s.fils.push(normalize(val));
        else if (key === 'id') s.ids = (s.ids || []).concat((val.match(/\d+/g) || []).map(Number));
        else s.cat.push(normalize(val));
      } else if (/^#\d+$/.test(t)) {
        s.ids = (s.ids || []).concat([Number(t.slice(1))]);
      } else {
        s.terms.push(normalize(t.replace(/^"|"$/g, '')));
      }
    });
    return s;
  }

  function anyHit(list, needle) {
    for (var i = 0; i < list.length; i++) if (list[i].indexOf(needle) !== -1) return true;
    return false;
  }

  function matchesSearch(q, s) {
    if (!s.active) return true;
    if (s.ids && s.ids.length && s.ids.indexOf(Number(q.num)) === -1) return false;
    var ix = getIndex(q), i;
    for (i = 0; i < s.terms.length; i++) if (ix.all.indexOf(s.terms[i]) === -1) return false;
    for (i = 0; i < s.cols.length; i++) if (!anyHit(ix.cols, s.cols[i])) return false;
    for (i = 0; i < s.fils.length; i++) if (!anyHit(ix.fils, s.fils[i])) return false;
    for (i = 0; i < s.cat.length; i++) if (!anyHit((q.categories || []).map(normalize), s.cat[i])) return false;
    return true;
  }

  function highlight(text, terms) {
    text = String(text == null ? '' : text);
    if (!terms || !terms.length) return esc(text);
    var nt = normalize(text);
    if (nt.length !== text.length) return esc(text);
    var ranges = [];
    terms.forEach(function (t) {
      if (!t) return;
      var i = 0;
      while ((i = nt.indexOf(t, i)) !== -1) { ranges.push([i, i + t.length]); i += t.length; }
    });
    if (!ranges.length) return esc(text);
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [ranges[0]];
    for (var k = 1; k < ranges.length; k++) {
      var last = merged[merged.length - 1];
      if (ranges[k][0] <= last[1]) last[1] = Math.max(last[1], ranges[k][1]); else merged.push(ranges[k]);
    }
    var out = '', pos = 0;
    merged.forEach(function (r) {
      out += esc(text.slice(pos, r[0])) + '<mark>' + esc(text.slice(r[0], r[1])) + '</mark>';
      pos = r[1];
    });
    return out + esc(text.slice(pos));
  }

  /* ---------- Filtros, ordenação e contagens ---------- */
  var collator = (window.Intl && Intl.Collator) ? new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' }) : null;
  function cmpName(a, b) { return collator ? collator.compare(a.name, b.name) : a.name.localeCompare(b.name, 'pt-BR'); }
  function stamp(q) { return q.updated_at || q.created_at || 0; }

  function selectedCats() { return Object.keys(state.cats); }

  function hasFilters() {
    return !!(state.search.trim() || selectedCats().length || state.onlyFav || state.review);
  }

  function visibleQueries() {
    var s = state.sq || (state.sq = parseSearch(state.search));
    var sel = selectedCats(), all = state.catMode === 'all';
    var list = state.queries.filter(function (q) {
      var cs = q.categories && q.categories.length ? q.categories : ['Outros'];
      if (sel.length) {
        var hit = all ? sel.every(function (c) { return cs.indexOf(c) !== -1; }) : sel.some(function (c) { return cs.indexOf(c) !== -1; });
        if (!hit) return false;
      }
      if (state.onlyFav && !state.favs[q.id]) return false;
      if (state.review && QH.reviewMatch && !QH.reviewMatch(q, state.review)) return false;
      return matchesSearch(q, s);
    });

    list.sort(function (a, b) {
      if (state.sort === 'recent') return stamp(b) - stamp(a);
      if (state.sort === 'id') return (a.num || 1e9) - (b.num || 1e9) || cmpName(a, b);
      if (state.sort === 'cols') return (b.columns || []).length - (a.columns || []).length || cmpName(a, b);
      return cmpName(a, b);
    });
    return list;
  }

  function recount() {
    var byCat = {}, fav = 0;
    state.queries.forEach(function (q) {
      if (state.favs[q.id]) fav++;
      (q.categories && q.categories.length ? q.categories : ['Outros']).forEach(function (c) { byCat[c] = (byCat[c] || 0) + 1; });
    });
    state.counts = { all: state.queries.length, fav: fav, byCat: byCat };
  }

  /* ---------- Cards ---------- */
  function isNewQuery(q) { return q.created_at && Date.now() - q.created_at < NEW_DAYS * 864e5; }
  function isUpdatedQuery(q) { return q.updated_at && q.created_at && q.updated_at - q.created_at > 6e4 && Date.now() - q.updated_at < NEW_DAYS * 864e5; }

  function badgesHtml(cats) {
    return cats.map(function (c) {
      var d = categoryOf(c);
      return '<span class="badge" style="background:' + d.color + ';color:' + d.fg + '">' + esc(c) + '</span>';
    }).join('');
  }

  function stripHtml(cats) {
    return '<div class="query-card__strip">' + cats.map(function (c) {
      return '<span style="background:' + categoryOf(c).color + '"></span>';
    }).join('') + '</div>';
  }

  function pillHtml(q) {
    return isNewQuery(q) ? '<span class="pill">Nova</span>' : (isUpdatedQuery(q) ? '<span class="pill">Atualizada</span>' : '');
  }

  function highlightColumns(q) {
    var map = {};
    (q.columns || []).forEach(function (c) { map[c.name] = c; });
    return (q.primary_columns || []).map(function (n) { return map[n]; }).filter(Boolean).slice(0, MAX_HIGHLIGHTS);
  }

  // Mostra de qual coluna ou filtro veio o resultado da busca
  function matchLine(q, s) {
    if (!s || !(s.terms.length || s.cols.length || s.fils.length)) return '';
    var nd = normalize(q.name + ' ' + (q.description || ''));
    var needs = s.cols.length || s.fils.length || s.terms.some(function (t) { return nd.indexOf(t) === -1; });
    if (!needs) return '';
    var needles = s.terms.concat(s.cols), hits = [];
    (q.columns || []).forEach(function (c) {
      var cn = normalize(c.name + ' ' + c.label);
      if (needles.some(function (t) { return cn.indexOf(t) !== -1; })) hits.push(c.name);
    });
    var fhits = [];
    (q.required_filters || []).forEach(function (f) {
      var fn = normalize(f.name + ' ' + f.label);
      if (s.fils.concat(s.terms).some(function (t) { return fn.indexOf(t) !== -1; })) fhits.push(f.name);
    });
    if (!hits.length && !fhits.length) return '';
    var parts = [];
    if (hits.length) parts.push('Coluna: ' + hits.slice(0, 3).map(function (h) { return '<code>' + highlight(h, needles) + '</code>'; }).join(', ') + (hits.length > 3 ? ' +' + (hits.length - 3) : ''));
    if (fhits.length) parts.push('Filtro: ' + fhits.slice(0, 3).map(function (h) { return '<code>' + highlight(h, s.fils.concat(s.terms)) + '</code>'; }).join(', '));
    return '<div class="query-card__match">' + parts.join(' · ') + '</div>';
  }

  function cardHtml(q) {
    var s = state.sq, id = esc(q.id), terms = s ? s.terms : [];
    var cats = (q.categories && q.categories.length ? q.categories : ['Outros']).slice(0, MAX_CATEGORIES);
    var hl = highlightColumns(q), extra = (q.columns || []).length - hl.length;
    var fav = !!state.favs[q.id], sel = !!state.selected[q.id];

    return '' +
      '<article class="query-card' + (sel ? ' is-selected' : '') + '" data-id="' + id + '">' +
        stripHtml(cats) +
        '<div class="query-card__main">' +
          '<div class="query-card__meta">' +
            (q.num ? '<span class="qid" title="ID da consulta">' + formatId(q.num) + '</span>' : '') +
            '<div class="badges">' + badgesHtml(cats) + '</div>' + pillHtml(q) +
          '</div>' +
          '<h3 class="query-card__title"><button type="button" class="query-card__open" data-action="open" data-id="' + id + '">' + highlight(q.name, terms) + '</button></h3>' +
          '<p class="query-card__desc' + (q.description ? '' : ' is-empty') + '">' + (q.description ? highlight(q.description, terms) : 'Sem descrição cadastrada.') + '</p>' +
          '<div class="tags">' +
            hl.map(function (c) { return '<span class="tag">' + esc(c.label) + '</span>'; }).join('') +
            (extra > 0 ? '<span class="tag tag--more">+ ' + extra + ' campos</span>' : '') +
          '</div>' +
          matchLine(q, s) +
        '</div>' +
        '<div class="query-card__actions">' +
          '<label class="query-card__select" title="Selecionar"><input type="checkbox" data-select="' + id + '"' + (sel ? ' checked' : '') + ' aria-label="Selecionar ' + esc(q.name) + '"></label>' +
          '<button type="button" class="star-btn' + (fav ? ' is-on' : '') + '" data-action="fav" data-id="' + id + '" aria-label="Favoritar" title="Favoritar">' + (fav ? '★' : '☆') + '</button>' +
          '<button type="button" class="btn btn--primary btn--sm" data-action="download" data-id="' + id + '">Baixar JSON</button>' +
        '</div>' +
      '</article>';
  }

  /* ---------- Renderização ---------- */
  function renderChips() {
    var c = state.counts, sel = state.cats, n = selectedCats().length;
    var html = '<button type="button" class="chip' + (state.onlyFav ? ' is-active' : '') + '" data-chip="fav" aria-pressed="' + (state.onlyFav ? 'true' : 'false') + '">★ Favoritas <span class="chip__count">' + c.fav + '</span></button>';
    CATEGORIES.forEach(function (cat) {
      html += '<button type="button" class="chip' + (sel[cat.name] ? ' is-active' : '') + '" data-chip="cat" data-cat="' + esc(cat.name) + '" aria-pressed="' + (sel[cat.name] ? 'true' : 'false') + '">' +
        '<span class="chip__dot" style="background:' + cat.color + '"></span>' + esc(cat.name) + ' <span class="chip__count">' + (c.byCat[cat.name] || 0) + '</span></button>';
    });
    if (n >= 2) {
      html += '<span class="chip-mode" role="group" aria-label="Combinar categorias"><button type="button" data-catmode="any" class="' + (state.catMode === 'any' ? 'is-active' : '') + '">Qualquer</button>' +
        '<button type="button" data-catmode="all" class="' + (state.catMode === 'all' ? 'is-active' : '') + '">Todas</button></span>';
    }
    $('categoryChips').innerHTML = html;
    renderActive();
  }

  // Filtros ativos: aparecem como etiquetas que podem ser removidas
  function activeList() {
    var out = [];
    selectedCats().forEach(function (c) { out.push({ key: 'cat:' + c, label: c, color: categoryOf(c).color }); });
    if (state.onlyFav) out.push({ key: 'fav', label: '★ Favoritas' });
    if (state.review) out.push({ key: 'review', label: QH.reviewLabel ? QH.reviewLabel(state.review) : state.review });
    return out;
  }

  function renderActive() {
    var list = activeList(), box = $('activeFilters'), badge = $('filterBadge');
    badge.textContent = list.length;
    badge.classList.toggle('hidden', !list.length);
    box.classList.toggle('hidden', !list.length);
    var html = list.map(function (a) {
      return '<button type="button" class="pill-filter" data-remove="' + esc(a.key) + '" aria-label="Remover filtro ' + esc(a.label) + '">' +
        (a.color ? '<span class="chip__dot" style="background:' + a.color + '"></span>' : '') + esc(a.label) + ' <span aria-hidden="true">×</span></button>';
    }).join('');
    if (selectedCats().length >= 2) html += '<span class="active-note">' + (state.catMode === 'all' ? 'com todas as categorias' : 'com qualquer categoria') + '</span>';
    if (list.length > 1) html += '<button type="button" class="link-btn" data-remove="all">Limpar</button>';
    box.innerHTML = html;
  }

  function setFilters(open) {
    $('filterPanel').classList.toggle('is-open', open);
    $('filterBackdrop').classList.toggle('is-open', open);
    $('filters').classList.toggle('is-open', open);
    $('btnFilters').setAttribute('aria-expanded', String(open));
    $('filterPanel').setAttribute('aria-hidden', String(!open));
  }

  function filtersOpen() { return $('filterPanel').classList.contains('is-open'); }

  // Limpa categorias, favoritas e revisão (a busca continua como está)
  function clearChips() {
    state.cats = {}; state.onlyFav = false; state.review = '';
    renderChips();
    renderList();
    if (QH.afterRender) QH.afterRender();
  }

  function updateResultsHead() {
    var total = state.queries.length, n = state.view.length;
    $('resultCount').textContent = (n === total ? n : n + ' de ' + total) + (total === 1 ? ' consulta' : ' consultas');
    $('btnZipList').classList.toggle('hidden', !n);
    $('filterDone').textContent = n ? 'Ver ' + n + (n === 1 ? ' consulta' : ' consultas') : 'Nenhuma consulta';
    updateSelectAll();
  }

  function updateSelectAll() {
    var v = state.view;
    $('selectAll').checked = v.length > 0 && v.every(function (q) { return state.selected[q.id]; });
  }

  function pageCount() {
    return Math.max(1, Math.ceil(state.view.length / PER_PAGE));
  }

  // Lista das páginas a mostrar no rodapé, com reticências quando há muitas
  function pageItems(cur, total) {
    if (total <= 7) {
      var all = [];
      for (var i = 1; i <= total; i++) all.push(i);
      return all;
    }
    var set = {};
    [1, 2, total - 1, total, cur - 1, cur, cur + 1].forEach(function (p) {
      if (p >= 1 && p <= total) set[p] = true;
    });
    var pages = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    var out = [];
    for (var k = 0; k < pages.length; k++) {
      if (k && pages[k] - pages[k - 1] > 1) out.push('…');
      out.push(pages[k]);
    }
    return out;
  }

  function renderPager() {
    var end = $('listEnd'), total = pageCount(), cur = state.page, n = state.view.length;
    if (n <= PER_PAGE) { end.classList.add('hidden'); end.innerHTML = ''; return; }
    end.classList.remove('hidden');

    var from = (cur - 1) * PER_PAGE + 1, to = Math.min(n, cur * PER_PAGE);
    var html = '<nav class="pager" role="navigation" aria-label="Paginação das consultas">';
    html += '<button type="button" class="pager__btn" data-page="' + (cur - 1) + '"' + (cur <= 1 ? ' disabled' : '') + ' aria-label="Página anterior">‹</button>';
    pageItems(cur, total).forEach(function (p) {
      if (p === '…') { html += '<span class="pager__gap" aria-hidden="true">…</span>'; return; }
      var active = p === cur;
      html += '<button type="button" class="pager__btn pager__num' + (active ? ' is-active' : '') + '" data-page="' + p + '"' +
        (active ? ' aria-current="page"' : '') + ' aria-label="Página ' + p + '">' + p + '</button>';
    });
    html += '<button type="button" class="pager__btn" data-page="' + (cur + 1) + '"' + (cur >= total ? ' disabled' : '') + ' aria-label="Próxima página">›</button>';
    html += '</nav>';
    html += '<div class="pager__info">Página ' + cur + ' de ' + total + ' · ' + from + '–' + to + ' de ' + n + '</div>';
    end.innerHTML = html;
  }

  function renderPage() {
    var v = state.view, total = pageCount();
    if (state.page > total) state.page = total;
    if (state.page < 1) state.page = 1;
    var from = (state.page - 1) * PER_PAGE, to = Math.min(v.length, from + PER_PAGE);
    var html = '';
    for (var i = from; i < to; i++) html += cardHtml(v[i]);
    $('queryList').innerHTML = html;
    renderPager();
  }

  // Troca de página: redesenha e leva o foco de volta ao topo da lista
  function goToPage(p) {
    var total = pageCount();
    p = Math.min(Math.max(1, p), total);
    if (p === state.page) return;
    state.page = p;
    renderPage();
    updateSelectAll();
    var top = $('queryList');
    if (top) {
      var y = top.getBoundingClientRect().top + window.scrollY - 90;
      window.scrollTo({ top: Math.max(0, y), behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
  }

  function renderList() {
    state.sq = parseSearch(state.search);
    state.view = visibleQueries();
    state.page = 1;
    renderPage();
    updateResultsHead();

    var empty = $('emptyState'), none = !state.view.length;
    empty.classList.toggle('hidden', !none);
    var ec = $('emptyClear');
    if (ec) ec.classList.toggle('hidden', !(none && state.queries.length && hasFilters()));
    if (none) {
      var hasData = state.queries.length > 0;
      $('emptyTitle').textContent = hasData ? 'Nenhuma consulta encontrada' : (state.loadError ? 'Não foi possível carregar' : 'Nenhuma consulta cadastrada');
      $('emptyText').textContent = hasData
        ? 'Tente outro termo ou limpe os filtros.'
        : (state.loadError || (ADMIN ? 'Clique em "Cadastrar" para enviar um JSON, vários arquivos ou um ZIP.' : 'A biblioteca ainda não tem consultas publicadas.'));
    }
  }

  function renderBulk() {
    var n = selectedIds().length;
    $('bulkBar').classList.toggle('hidden', n === 0);
    $('bulkCount').textContent = n + (n === 1 ? ' selecionada' : ' selecionadas');
  }

  function renderAll() {
    renderChips();
    renderList();
    renderBulk();
    if (state.loaded) $('skeleton').classList.add('hidden');
    if (QH.afterRender) QH.afterRender();
  }

  // Chamado quando os dados mudam (importação, edição, exclusão)
  function dataChanged() {
    recount();
    renderAll();
  }

  /* ---------- Painel de detalhes ---------- */
  var lastFocus = null;

  function updateFavButton() {
    var q = findQuery(state.openId);
    if (q) $('drawerFav').textContent = state.favs[q.id] ? '★ Favorita' : '☆ Favoritar';
  }

  function linkFor(q) {
    return window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + (q.num ? '#c=' + q.num : '');
  }

  function openDrawer(id) {
    var q = findQuery(id);
    if (!q) return;
    var wasOpen = state.openId !== null;
    if (!wasOpen) lastFocus = document.activeElement;
    state.openId = id;

    var cats = q.categories && q.categories.length ? q.categories : ['Outros'];
    $('drawerBadges').innerHTML = badgesHtml(cats);
    var idEl = $('drawerId');
    idEl.classList.toggle('hidden', !q.num);
    idEl.textContent = q.num ? formatId(q.num) : '';
    var pill = $('drawerPill'), pt = isNewQuery(q) ? 'Nova' : (isUpdatedQuery(q) ? 'Atualizada' : '');
    pill.classList.toggle('hidden', !pt);
    pill.textContent = pt;
    $('drawerTitle').textContent = q.name;
    $('drawerDesc').textContent = q.description || '';
    $('colSearch').value = '';
    updateFavButton();

    var filters = q.required_filters || [];
    $('drawerFilters').innerHTML = filters.length
      ? '<div class="filter-list">' + filters.map(function (f) {
          return '<span class="filter-item"><b>' + esc(f.label) + '</b> <small>' + esc(f.name) + '</small></span>';
        }).join('') + '</div>'
      : '<p class="muted-text">Nenhum filtro obrigatório detectado.</p>';

    renderDrawerColumns();

    var idx = state.view.indexOf(q);
    $('drawerPrev').disabled = idx <= 0;
    $('drawerNext').disabled = idx === -1 || idx >= state.view.length - 1;
    $('drawerPos').textContent = idx === -1 ? '' : (idx + 1) + ' de ' + state.view.length;
    $('drawer').scrollTop = 0;

    $('drawerOverlay').classList.add('is-open');
    $('drawer').classList.add('is-open');
    $('drawer').setAttribute('aria-hidden', 'false');
    if (!wasOpen) setTimeout(function () { $('drawerClose').focus({ preventScroll: true }); }, 60);

    if (q.num) { try { history.replaceState(null, '', '#c=' + q.num); } catch (err) { /* ignora */ } }
    if (QH.hooks.drawerOpened) QH.hooks.drawerOpened(q);
  }

  function renderDrawerColumns() {
    var q = findQuery(state.openId);
    if (!q) return;
    var term = normalize($('colSearch').value);
    var cols = (q.columns || []).filter(function (c) {
      return !term || normalize(c.name + ' ' + c.label).indexOf(term) !== -1;
    });
    $('drawerColsTitle').textContent = 'Colunas retornadas (' + (q.columns || []).length + ')';
    $('drawerCols').innerHTML = cols.length
      ? cols.map(function (c) {
          return '<div class="col-item"><b>' + esc(c.label) + '</b><small>' + esc(c.name) + ' · ' + esc(c.type) + '</small></div>';
        }).join('')
      : '<p class="muted-text">Nenhuma coluna encontrada.</p>';
  }

  function closeDrawer() {
    if (state.openId === null) return;
    state.openId = null;
    $('drawerOverlay').classList.remove('is-open');
    $('drawer').classList.remove('is-open');
    $('drawer').setAttribute('aria-hidden', 'true');
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (err) { /* ignora */ }
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (err) { /* ignora */ } }
  }

  function stepDrawer(delta) {
    var q = findQuery(state.openId);
    if (!q) return;
    var next = state.view[state.view.indexOf(q) + delta];
    if (next) openDrawer(next.id);
  }

  function openFromHash() {
    var m = String(window.location.hash || '').match(/^#c=(\d+)$/);
    if (!m) return;
    var num = Number(m[1]);
    var q = state.queries.filter(function (x) { return Number(x.num) === num; })[0];
    if (q) openDrawer(q.id);
    else if (state.loaded) toast('Não encontrei a consulta ' + formatId(num) + '. Ela pode ter sido removida.');
  }

  /* ---------- Downloads ---------- */
  var jszipPromise = null;
  function ensureJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (!jszipPromise) {
      jszipPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'js/vendor/jszip.min.js';
        s.onload = function () { resolve(window.JSZip); };
        s.onerror = function () { jszipPromise = null; reject(new Error('Não foi possível carregar o módulo de ZIP.')); };
        document.head.appendChild(s);
      });
    }
    return jszipPromise;
  }

  function downloadQuery(id) {
    var q = findQuery(id);
    if (!q) return;
    download(q.source_filename || (q.name + '.json'), JSON.stringify(q.raw_json, null, 2));
  }

  function downloadZip(list, zipName) {
    if (!list.length) { toast('Nenhuma consulta para baixar.'); return; }
    toast('Preparando o ZIP...');
    ensureJSZip().then(function (JSZip) {
      var zip = new JSZip(), used = {};
      list.forEach(function (q) {
        var base = (q.source_filename || (slug(q.name) + '.json')).replace(/\.json$/i, '');
        used[base] = (used[base] || 0) + 1;
        var name = used[base] > 1 ? base + '_' + used[base] + '.json' : base + '.json';
        zip.file(name, JSON.stringify(q.raw_json, null, 2));
      });
      return zip.generateAsync({ type: 'blob' });
    }).then(function (blob) {
      download(zipName, blob);
      toast(list.length + ' consulta(s) no ZIP.');
    }).catch(function (err) { toast(err.message); });
  }

  /* ---------- Pedido de ajuste (abre o e-mail já preenchido) ---------- */
  function mailLines(q, f, opts) {
    var cats = (q.categories || []).join(', ') || 'Outros';
    var L = [];
    L.push('Olá,', '', 'Gostaria de pedir um ajuste na consulta dinâmica abaixo.', '');
    L.push('CONSULTA');
    L.push('ID: ' + (q.num ? formatId(q.num) : '(sem ID)'));
    L.push('Nome: ' + q.name);
    L.push('Categorias: ' + cats);
    if (q.source_filename) L.push('Arquivo: ' + q.source_filename);
    if (q.num) L.push('Link: ' + linkFor(q));
    L.push('');
    L.push('PEDIDO');
    L.push('Tipo de ajuste: ' + f.type);
    L.push('Urgência: ' + f.urgency);
    L.push('Descrição:', f.text.length > opts.maxText ? f.text.slice(0, opts.maxText) + '… (texto cortado)' : f.text);
    if (opts.cols) {
      var cols = (q.columns || []).map(function (c) { return c.name; });
      L.push('', 'Colunas atuais (' + cols.length + '): ' + cols.slice(0, 12).join(', ') + (cols.length > 12 ? ' e mais ' + (cols.length - 12) : ''));
      var fil = (q.required_filters || []).map(function (x) { return x.name; });
      if (fil.length) L.push('Filtros: ' + fil.join(', '));
    }
    if (opts.json) L.push('', 'JSON DA CONSULTA', opts.json);
    else if (f.download) L.push('', '(O arquivo JSON da consulta foi baixado e segue em anexo.)');
    L.push('', 'Solicitante: ' + ((state.user && state.user.email) || '(não identificado)'));
    return L.join('\r\n');
  }

  function buildEmail(q, f) {
    var subject = 'Pedido de ajuste – Consulta ' + (q.num ? formatId(q.num) + ' – ' : '') + q.name.slice(0, 80);
    var rawJson = f.inline ? JSON.stringify(q.raw_json) : '';
    var attempts = [
      { cols: true, json: rawJson, maxText: 1000 },
      { cols: true, json: '', maxText: 1000 },
      { cols: false, json: '', maxText: 1000 },
      { cols: false, json: '', maxText: 600 },
      { cols: false, json: '', maxText: 300 }
    ];
    var best = null;
    for (var i = 0; i < attempts.length; i++) {
      var body = mailLines(q, f, attempts[i]);
      var url = 'mailto:' + REQUEST_EMAIL + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
      best = { subject: subject, body: body, url: url, trimmed: i > 0 && !(i === 1 && !rawJson), droppedJson: !!rawJson && !attempts[i].json };
      if (url.length <= MAILTO_LIMIT) break;
    }
    return best;
  }

  function reqFields() {
    return {
      type: $('reqType').value, urgency: $('reqUrgency').value, text: $('reqText').value.trim(),
      download: $('reqDownload').checked, inline: $('reqInline').checked && !$('reqInline').disabled
    };
  }

  function openRequest(q) {
    if (!q) return;
    state.request = q;
    var cats = (q.categories || []).join(' · ') || 'Outros';
    $('reqCard').innerHTML = (q.num ? '<span class="qid">' + formatId(q.num) + '</span> ' : '') + '<b>' + esc(q.name) + '</b><br>' + esc(cats) + ' · ' + (q.columns || []).length + ' colunas';
    $('reqTo').textContent = REQUEST_EMAIL;
    $('reqText').value = '';
    $('reqCount').textContent = '0 / 1000';
    $('reqError').textContent = '';
    $('reqNote').textContent = '';
    $('reqDownload').checked = true;
    var small = JSON.stringify(q.raw_json).length <= 600;
    $('reqInline').checked = false;
    $('reqInline').disabled = !small;
    $('reqInlineLabel').innerHTML = 'Colar o JSON no corpo do e-mail<small>' + (small ? 'Esta consulta é pequena o bastante.' : 'Esta consulta é grande demais para o corpo do e-mail. Use o arquivo baixado como anexo.') + '</small>';
    openModal($('requestModal'));
    setTimeout(function () { $('reqText').focus(); }, 80);
  }

  function sendRequest(copyOnly) {
    var q = state.request;
    if (!q) return;
    var f = reqFields();
    if (f.text.length < 10) { $('reqError').textContent = 'Descreva o ajuste com pelo menos 10 caracteres.'; $('reqText').focus(); return; }
    $('reqError').textContent = '';
    var mail = buildEmail(q, f);
    var notes = [];
    if (mail.trimmed) notes.push('O e-mail foi encurtado para caber no link.');
    if (mail.droppedJson) notes.push('O JSON não coube no corpo; use o anexo.');
    $('reqNote').textContent = notes.join(' ');

    if (copyOnly) {
      copyText('Para: ' + REQUEST_EMAIL + '\r\nAssunto: ' + mail.subject + '\r\n\r\n' + mail.body)
        .then(function () { toast('Texto do e-mail copiado.'); })
        .catch(function () { toast('Não consegui copiar automaticamente.'); });
      return;
    }
    if (f.download) downloadQuery(q.id);
    var a = document.createElement('a');
    a.href = mail.url;
    document.body.appendChild(a);
    a.click();
    a.remove();
    closeModal($('requestModal'));
    toast(f.download ? 'E-mail aberto. Anexe o JSON que foi baixado.' : 'E-mail aberto.');
  }

  /* ---------- Eventos ---------- */
  function setSearch(value) {
    state.search = value;
    renderList();
  }

  function clearFilters() {
    state.search = ''; state.cats = {}; state.onlyFav = false; state.review = '';
    $('searchInput').value = '';
    setFilters(false);
    renderChips();
    renderList();
    if (QH.afterRender) QH.afterRender();
  }

  function bindCore() {
    on('btnLogout', 'click', logout);

    // Busca (com pequena espera enquanto digita) e ordenação
    var onSearch = debounce(function (v) { setSearch(v); }, 140);
    on('searchInput', 'input', function (e) { onSearch(e.target.value); });
    on('sortSelect', 'change', function (e) { state.sort = e.target.value; renderList(); });
    on('emptyClear', 'click', clearFilters);

    // Caixa de filtros
    on('btnFilters', 'click', function () { setFilters(!filtersOpen()); });
    on('filterDone', 'click', function () { setFilters(false); });
    on('filterBackdrop', 'click', function () { setFilters(false); });
    on('filterClear', 'click', clearChips);

    // Chips de categoria (várias ao mesmo tempo)
    on('categoryChips', 'click', function (e) {
      var mode = e.target.closest('[data-catmode]');
      if (mode) { state.catMode = mode.getAttribute('data-catmode'); renderChips(); renderList(); return; }
      var chip = e.target.closest('[data-chip]');
      if (!chip) return;
      if (chip.getAttribute('data-chip') === 'fav') state.onlyFav = !state.onlyFav;
      else { var c = chip.getAttribute('data-cat'); if (state.cats[c]) delete state.cats[c]; else state.cats[c] = true; }
      renderChips();
      renderList();
    });

    // Etiquetas dos filtros ativos: clicar remove
    on('activeFilters', 'click', function (e) {
      var b = e.target.closest('[data-remove]');
      if (!b) return;
      var key = b.getAttribute('data-remove');
      if (key === 'all') { clearChips(); return; }
      if (key === 'fav') state.onlyFav = false;
      else if (key === 'review') state.review = '';
      else if (key.indexOf('cat:') === 0) delete state.cats[key.slice(4)];
      renderChips();
      renderList();
      if (QH.afterRender) QH.afterRender();
    });

    // Lista: clique no card abre os detalhes; botões e caixas têm ação própria
    on('queryList', 'click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (btn) {
        var id = btn.getAttribute('data-id');
        if (btn.getAttribute('data-action') === 'open') openDrawer(id);
        if (btn.getAttribute('data-action') === 'download') downloadQuery(id);
        if (btn.getAttribute('data-action') === 'fav') toggleFav(id);
        return;
      }
      if (e.target.closest('.query-card__select')) return;
      var card = e.target.closest('.query-card');
      if (card) openDrawer(card.getAttribute('data-id'));
    });

    on('queryList', 'change', function (e) {
      var box = e.target.closest('[data-select]');
      if (!box) return;
      var id = box.getAttribute('data-select');
      if (box.checked) state.selected[id] = true; else delete state.selected[id];
      var card = box.closest('.query-card');
      if (card) card.classList.toggle('is-selected', box.checked);
      renderBulk();
      updateSelectAll();
    });

    on('selectAll', 'change', function (e) {
      state.view.forEach(function (q) { if (e.target.checked) state.selected[q.id] = true; else delete state.selected[q.id]; });
      document.querySelectorAll('.query-card').forEach(function (card) {
        var on = !!state.selected[card.getAttribute('data-id')];
        card.classList.toggle('is-selected', on);
        var cb = card.querySelector('[data-select]'); if (cb) cb.checked = on;
      });
      renderBulk();
    });

    on('btnZipList', 'click', function () { downloadZip(state.view, 'consultas.zip'); });
    on('bulkZip', 'click', function () { downloadZip(selectedIds().map(findQuery).filter(Boolean), 'consultas_selecionadas.zip'); });
    on('bulkClear', 'click', function () { QH.clearSelection(); });

    // Paginação da lista
    on('listEnd', 'click', function (e) {
      var btn = e.target.closest('[data-page]');
      if (!btn || btn.disabled) return;
      goToPage(Number(btn.getAttribute('data-page')));
    });

    // Painel de detalhes
    on('drawerClose', 'click', closeDrawer);
    on('drawerOverlay', 'click', closeDrawer);
    on('drawerPrev', 'click', function () { stepDrawer(-1); });
    on('drawerNext', 'click', function () { stepDrawer(1); });
    on('colSearch', 'input', renderDrawerColumns);
    on('copyCols', 'click', function () {
      var q = findQuery(state.openId);
      if (!q) return;
      copyText((q.columns || []).map(function (c) { return c.name; }).join('\n')).then(function () { toast('Nomes das colunas copiados.'); }, function () { toast('Não consegui copiar automaticamente.'); });
    });
    on('drawerDownload', 'click', function () { downloadQuery(state.openId); });
    on('drawerCopyJson', 'click', function () {
      var q = findQuery(state.openId);
      if (!q) return;
      copyText(JSON.stringify(q.raw_json, null, 2)).then(function () { toast('JSON copiado.'); }, function () { toast('Não consegui copiar automaticamente.'); });
    });
    on('drawerCopyLink', 'click', function () {
      var q = findQuery(state.openId);
      if (!q) return;
      if (!q.num) { toast('Esta consulta ainda não tem ID. O link fica disponível depois que o administrador publicar.'); return; }
      copyText(linkFor(q)).then(function () { toast('Link da consulta ' + formatId(q.num) + ' copiado.'); }, function () { toast('Não consegui copiar automaticamente.'); });
    });
    on('drawerFav', 'click', function () { if (state.openId) toggleFav(state.openId); });
    on('drawerRequest', 'click', function () { openRequest(findQuery(state.openId)); });

    // Pedido de ajuste
    on('reqText', 'input', function (e) { $('reqCount').textContent = e.target.value.length + ' / 1000'; $('reqError').textContent = ''; });
    on('reqSend', 'click', function () { sendRequest(false); });
    on('reqCopy', 'click', function () { sendRequest(true); });

    // Pop-ups: fechar com ×, Cancelar, Esc ou clique fora (com animação)
    document.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () { closeModal($(btn.getAttribute('data-close'))); });
    });
    document.querySelectorAll('dialog').forEach(function (dlg) {
      var heading = dlg.querySelector('.modal__title');
      if (heading) { if (!heading.id) heading.id = dlg.id + 'Title'; dlg.setAttribute('aria-labelledby', heading.id); }
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); closeModal(dlg); });
      dlg.addEventListener('mousedown', function (e) {
        if (e.target !== dlg) return;
        var r = dlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeModal(dlg);
      });
    });

    // Voltar ao topo
    var toTop = $('toTop'), ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { toTop.classList.toggle('is-visible', window.scrollY > 700); ticking = false; });
    }, { passive: true });
    toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); });

    window.addEventListener('hashchange', openFromHash);

    // Atalhos: "/" busca · setas navegam no painel · Esc fecha o painel
    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement ? document.activeElement.tagName : '';
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (document.activeElement && document.activeElement.isContentEditable);
      var modalOpen = !!document.querySelector('dialog[open]');
      if (e.key === '/' && !typing && !modalOpen) { e.preventDefault(); $('searchInput').focus(); return; }
      if (state.openId && !typing && !modalOpen) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); stepDrawer(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); stepDrawer(1); }
      }
      if (e.key === 'Escape' && filtersOpen()) { setFilters(false); return; }
      if (e.key === 'Escape' && state.openId && !modalOpen) closeDrawer();
    });
  }

  /* ---------- Início ---------- */
  function finishLoad() {
    state.loaded = true;
    recount();
    renderAll();
    openFromHash();
    if (QH.hooks.loaded) QH.hooks.loaded();
  }

  function boot() {
    bindCore();
    if (QH.hooks.bind) QH.hooks.bind();
    loadFavs();
    loadUser();
    var loader = QH.loadLibrary || function () {
      return fetchLibrary().then(function (list) { state.queries = list; }).catch(function (err) { state.loadError = err.message; toast(err.message); });
    };
    Promise.resolve(loader()).then(finishLoad, finishLoad);
  }

  // API para o painel admin
  QH.$ = $; QH.on = on; QH.esc = esc; QH.normalize = normalize; QH.slug = slug; QH.toast = toast; QH.download = download; QH.copyText = copyText;
  QH.openModal = openModal; QH.closeModal = closeModal; QH.ensureJSZip = ensureJSZip; QH.findQuery = findQuery; QH.selectedIds = selectedIds;
  QH.visibleQueries = visibleQueries; QH.renderAll = renderAll; QH.renderList = renderList; QH.renderChips = renderChips; QH.renderBulk = renderBulk;
  QH.dataChanged = dataChanged; QH.recount = recount; QH.openDrawer = openDrawer; QH.closeDrawer = closeDrawer; QH.invalidate = invalidate;
  QH.downloadQuery = downloadQuery; QH.formatId = formatId; QH.linkFor = linkFor; QH.categoryOf = categoryOf; QH.fetchLibrary = fetchLibrary;
  QH.reducedMotion = reducedMotion; QH.debounce = debounce;
  QH.clearSelection = function () {
    state.selected = {};
    document.querySelectorAll('.query-card.is-selected').forEach(function (c) {
      c.classList.remove('is-selected');
      var cb = c.querySelector('[data-select]'); if (cb) cb.checked = false;
    });
    renderBulk();
    updateSelectAll();
  };
  QH.clearChips = clearChips;
  QH.setSearch = function (v) { $('searchInput').value = v; setSearch(v); };
  QH.finishLoad = finishLoad;

  document.addEventListener('DOMContentLoaded', boot);
})();
