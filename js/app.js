/* ==========================================================================
   QueryHub | Lógica da aplicação
   Dois modos, definidos por <body data-mode="viewer|admin">:
   - viewer (index.html): consulta, busca, detalhes e download. Somente leitura.
   - admin  (admin.html): cadastro, edição e publicação para o GitHub.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- Configurações ---------- */
  var ADMIN = document.body.getAttribute('data-mode') === 'admin';
  var DATA_URL = 'data/queries.json';
  var DRAFT_KEY = 'queryhub:admin-draft:v2';
  var FAV_KEY = 'queryhub:favorites:v1';
  var MAX_CATEGORIES = 3;
  var MAX_HIGHLIGHTS = 4;

  var CATEGORIES = [
    { name: 'Clientes',    color: '#2754d7' },
    { name: 'Pedidos',     color: '#ee6757' },
    { name: 'Faturamento', color: '#3aae2d' },
    { name: 'Marketplace', color: '#7a4fc4' },
    { name: 'Financeiro',  color: '#1a9a8f' },
    { name: 'Produtos',    color: '#d9a400' },
    { name: 'Estoque',     color: '#f08a2c' },
    { name: 'Preço',       color: '#7fae1b' },
    { name: 'Outros',      color: '#8a94a0' }
  ];

  /* Palavras do nome da consulta usadas para sugerir categorias na importação em lote */
  var CATEGORY_HINTS = [
    { name: 'Clientes',    re: /cliente|pessoa|contato|cadastro/ },
    { name: 'Pedidos',     re: /pedido|venda|carrinho|entrega|rastreio|frete/ },
    { name: 'Faturamento', re: /faturamento|fatura|nota fiscal|\bnf\b|nfe/ },
    { name: 'Marketplace', re: /marketplace|amazon|shopee|magalu|mercado livre|americanas|\bb2w\b/ },
    { name: 'Financeiro',  re: /financeiro|pagamento|recebiv|conciliacao|boleto|cartao|repasse/ },
    { name: 'Produtos',    re: /produto|\bsku\b|marca|derivacao|categoria/ },
    { name: 'Estoque',     re: /estoque|saldo|deposito/ },
    { name: 'Preço',       re: /preco|tabela de|promocao|desconto/ }
  ];

  var ACRONYMS = { sku: 'SKU', id: 'ID', nf: 'NF', cpf: 'CPF', cnpj: 'CNPJ', uf: 'UF', cep: 'CEP' };

  /* ---------- Estado ---------- */
  var state = {
    queries: [],
    favs: {},          // id -> true (guardado só no navegador de cada pessoa)
    search: '',
    category: '',      // '' = todas | '__fav' = favoritas | nome da categoria
    sort: 'name',
    selected: {},      // id -> true
    openId: null,
    editing: null,     // { query, isNew }
    dirty: false,      // admin: há alterações ainda não publicadas
    publishing: false
  };

  /* ---------- Utilitários ---------- */
  function $(id) { return document.getElementById(id); }

  // Registra um evento só se o elemento existir (o viewer não tem os controles de admin)
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

  function colorOf(categoryName) {
    var cat = CATEGORIES.filter(function (c) { return c.name === categoryName; })[0];
    return cat ? cat.color : '#8a94a0';
  }

  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.classList.add('is-visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.classList.remove('is-visible'); }, 4200);
  }

  function humanize(name, title) {
    if (title && String(title).trim()) return String(title).trim();
    return String(name || '')
      .replace(/^:/, '')
      .split(/[_\s]+/)
      .filter(Boolean)
      .map(function (w) { return ACRONYMS[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); })
      .join(' ');
  }

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

  function selectedIds() { return Object.keys(state.selected); }

  /* ---------- Leitura do JSON da consulta dinâmica ---------- */
  function guessCategories(name) {
    var text = normalize(name);
    var found = CATEGORY_HINTS
      .filter(function (hint) { return hint.re.test(text); })
      .map(function (hint) { return hint.name; })
      .slice(0, 2);
    return found.length ? found : ['Outros'];
  }

  function parseQuery(data, fileName) {
    if (!data || !Array.isArray(data.field) || typeof data.query !== 'string') {
      throw new Error('estrutura inválida (esperado "field" e "query")');
    }

    var seen = {};
    var columns = data.field
      .filter(function (f) { return Number(f.tipo) === 1 && f.name; })
      .filter(function (f) {
        if (seen[f.name]) return false;
        seen[f.name] = true;
        return true;
      })
      .map(function (f) {
        return { name: String(f.name), label: humanize(f.name, f.title), type: String(f.typeField || 'text') };
      });

    // Parâmetros do SQL (:parametro), ignorando casts do tipo ::text
    var params = [];
    var re = /(^|[^:]):([A-Za-z_][A-Za-z0-9_]*)/g;
    var match;
    while ((match = re.exec(data.query)) !== null) {
      if (params.indexOf(match[2]) === -1) params.push(match[2]);
    }

    var filters = params.map(function (p) {
      var field = data.field.filter(function (f) {
        return String(f.name || '').replace(/^:/, '').toLowerCase() === p.toLowerCase();
      })[0] || {};
      return { name: ':' + p, label: humanize(p, field.title), type: String(field.typeField || 'date') };
    });

    var name = String(data.name || fileName.replace(/\.json$/i, '')).trim();

    return {
      id: 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: name,
      categories: guessCategories(name),
      description: '',
      source_filename: fileName,
      columns: columns,
      primary_columns: columns.slice(0, 3).map(function (c) { return c.name; }),
      required_filters: filters,
      created_at: Date.now(),
      raw_json: data
    };
  }

  /* ---------- Favoritas (somente no navegador de cada pessoa) ---------- */
  function loadFavs() {
    try { state.favs = JSON.parse(localStorage.getItem(FAV_KEY) || '{}') || {}; } catch (err) { state.favs = {}; }
  }

  function toggleFav(id) {
    if (state.favs[id]) delete state.favs[id]; else state.favs[id] = true;
    try { localStorage.setItem(FAV_KEY, JSON.stringify(state.favs)); } catch (err) { /* sem espaço: ignora */ }
    renderAll();
  }

  /* ---------- Rascunho do admin (guardado no navegador até publicar) ---------- */
  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (err) { return null; }
  }

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ queries: state.queries, dirty: state.dirty }));
    } catch (err) {
      toast('O rascunho é grande demais para o navegador. Publique logo para não perder as alterações.');
    }
  }

  // Chamado depois de qualquer alteração na biblioteca
  function changed() {
    if (ADMIN) { state.dirty = true; saveDraft(); }
    renderAll();
  }

  /* ---------- Carregamento da biblioteca ---------- */
  function fetchLibrary() {
    return fetch(DATA_URL, { cache: 'no-store' }).then(function (res) {
      if (res.status === 401) { window.location.replace('/login.html'); throw new Error('Sessão expirada.'); }
      if (!res.ok) throw new Error('Não foi possível carregar a biblioteca.');
      return res.json();
    }).then(function (data) { return Array.isArray(data) ? data : []; });
  }

  function init() {
    loadUser();
    loadFavs();

    if (ADMIN) {
      var draft = loadDraft();
      if (draft && Array.isArray(draft.queries) && (draft.queries.length || draft.dirty)) {
        state.queries = draft.queries;
        state.dirty = !!draft.dirty;
        renderAll();
        return;
      }
    }

    fetchLibrary()
      .then(function (list) { state.queries = list; })
      .catch(function (err) { toast(err.message); })
      .then(renderAll);
  }

  /* ---------- Sessão (login com Google, ativo apenas no site publicado) ---------- */
  function loadUser() {
    fetch('/api/me', { cache: 'no-store' }).then(function (res) {
      if (res.status === 401) { window.location.replace('/login.html'); return null; }
      return res.ok ? res.json() : null;
    }).then(function (user) {
      if (!user) return;
      if (ADMIN && user.role !== 'admin') { window.location.replace('/'); return; }
      $('userEmail').textContent = user.email;
      $('userBox').classList.remove('hidden');
      var adminLink = $('adminLink');
      if (adminLink && user.role === 'admin') adminLink.classList.remove('hidden');
    }).catch(function () { /* sem /api (ex.: Live Server): segue sem mostrar o usuário */ });
  }

  function logout() {
    fetch('/api/logout', { method: 'POST' }).finally(function () {
      window.location.replace('/login.html');
    });
  }

  /* ---------- Renderização: lista ---------- */
  function findQuery(id) {
    return state.queries.filter(function (q) { return q.id === id; })[0];
  }

  function visibleQueries() {
    var term = normalize(state.search);

    var list = state.queries.filter(function (q) {
      var cats = q.categories || ['Outros'];
      if (state.category === '__fav') {
        if (!state.favs[q.id]) return false;
      } else if (state.category && cats.indexOf(state.category) === -1) {
        return false;
      }
      if (!term) return true;
      var haystack = normalize([q.name, q.description].concat(cats).concat(
        (q.columns || []).map(function (c) { return c.name + ' ' + c.label; })
      ).join(' '));
      return haystack.indexOf(term) !== -1;
    });

    list.sort(function (a, b) {
      if (state.sort === 'recent') return (b.created_at || 0) - (a.created_at || 0);
      return a.name.localeCompare(b.name, 'pt-BR');
    });
    return list;
  }

  function highlightColumns(q) {
    var map = {};
    (q.columns || []).forEach(function (c) { map[c.name] = c; });
    return (q.primary_columns || []).map(function (n) { return map[n]; }).filter(Boolean).slice(0, MAX_HIGHLIGHTS);
  }

  function badgesHtml(cats) {
    return cats.map(function (c) {
      return '<span class="badge" style="background:' + colorOf(c) + '">' + esc(c) + '</span>';
    }).join('');
  }

  function stripHtml(cats) {
    return '<div class="query-card__strip">' + cats.map(function (c) {
      return '<span style="background:' + colorOf(c) + '"></span>';
    }).join('') + '</div>';
  }

  function cardHtml(q) {
    var cats = (q.categories && q.categories.length ? q.categories : ['Outros']).slice(0, MAX_CATEGORIES);
    var highlights = highlightColumns(q);
    var extra = (q.columns || []).length - highlights.length;
    var id = esc(q.id);
    var fav = !!state.favs[q.id];

    return '' +
      '<article class="query-card' + (state.selected[q.id] ? ' is-selected' : '') + '">' +
        stripHtml(cats) +
        '<div class="query-card__main">' +
          '<div class="badges">' + badgesHtml(cats) + '</div>' +
          '<h3 class="query-card__title">' + esc(q.name) + '</h3>' +
          '<p class="query-card__desc">' + esc(q.description || 'Sem descrição cadastrada.') + '</p>' +
          '<div class="tags">' +
            highlights.map(function (c) { return '<span class="tag">' + esc(c.label) + '</span>'; }).join('') +
            (extra > 0 ? '<span class="tag tag--more">+ ' + extra + ' campos</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="query-card__actions">' +
          '<label class="query-card__select" title="Selecionar"><input type="checkbox" data-select="' + id + '"' + (state.selected[q.id] ? ' checked' : '') + '></label>' +
          '<button type="button" class="star-btn' + (fav ? ' is-on' : '') + '" data-action="fav" data-id="' + id + '" aria-label="Favoritar" title="Favoritar">' + (fav ? '★' : '☆') + '</button>' +
          '<button type="button" class="link-btn" data-action="open" data-id="' + id + '">Ver colunas</button>' +
          '<button type="button" class="btn btn--primary btn--sm" data-action="download" data-id="' + id + '">Baixar JSON</button>' +
        '</div>' +
      '</article>';
  }

  function renderChips() {
    var counts = {}, favs = 0;
    state.queries.forEach(function (q) {
      if (state.favs[q.id]) favs++;
      (q.categories || ['Outros']).forEach(function (c) { counts[c] = (counts[c] || 0) + 1; });
    });

    var html = '<button type="button" class="chip' + (state.category === '' ? ' is-active' : '') + '" data-category="">' +
      'Todas <span class="chip__count">' + state.queries.length + '</span></button>';

    html += '<button type="button" class="chip' + (state.category === '__fav' ? ' is-active' : '') + '" data-category="__fav">' +
      '★ Favoritas <span class="chip__count">' + favs + '</span></button>';

    CATEGORIES.forEach(function (cat) {
      html += '<button type="button" class="chip' + (state.category === cat.name ? ' is-active' : '') + '" data-category="' + esc(cat.name) + '">' +
        '<span class="chip__dot" style="background:' + cat.color + '"></span>' + esc(cat.name) +
        ' <span class="chip__count">' + (counts[cat.name] || 0) + '</span></button>';
    });
    $('categoryChips').innerHTML = html;
  }

  function renderList() {
    var list = visibleQueries();
    $('resultCount').textContent = list.length + (list.length === 1 ? ' consulta' : ' consultas');
    $('queryList').innerHTML = list.map(cardHtml).join('');

    var allSelected = list.length > 0 && list.every(function (q) { return state.selected[q.id]; });
    $('selectAll').checked = allSelected;
    $('btnZipList').classList.toggle('hidden', !list.length);

    var empty = $('emptyState');
    empty.classList.toggle('hidden', list.length > 0);
    if (!list.length) {
      var hasData = state.queries.length > 0;
      $('emptyTitle').textContent = hasData ? 'Nenhuma consulta encontrada' : 'Nenhuma consulta cadastrada';
      $('emptyText').textContent = hasData
        ? 'Tente outro termo de busca ou remova o filtro.'
        : (ADMIN ? 'Clique em "Cadastrar consultas" para enviar um JSON, vários arquivos ou um ZIP.' : 'A biblioteca ainda não tem consultas publicadas.');
    }
  }

  function renderBulk() {
    var n = selectedIds().length;
    $('bulkBar').classList.toggle('hidden', n === 0);
    $('bulkCount').textContent = n + (n === 1 ? ' selecionada' : ' selecionadas');
  }

  function renderPublish() {
    if (!ADMIN) return;
    $('btnPublish').textContent = state.publishing ? 'Publicando...' : (state.dirty ? 'Publicar alterações ●' : 'Publicar');
    $('btnPublish').disabled = state.publishing;
    $('publishHint').textContent = state.dirty
      ? 'Há alterações não publicadas. O time só vê o que for publicado.'
      : 'Tudo publicado. Esta é a mesma biblioteca que o time está vendo.';
  }

  function renderAll() {
    renderChips();
    renderList();
    renderBulk();
    renderPublish();
  }

  /* ---------- Drawer de detalhes ---------- */
  function updateFavButton(q) {
    $('drawerFav').textContent = state.favs[q.id] ? '★ Favorita' : '☆ Favoritar';
  }

  function openDrawer(id) {
    var q = findQuery(id);
    if (!q) return;
    state.openId = id;

    $('drawerBadges').innerHTML = badgesHtml(q.categories || ['Outros']);
    $('drawerTitle').textContent = q.name;
    $('drawerDesc').textContent = q.description || '';
    $('colSearch').value = '';
    updateFavButton(q);

    var filters = q.required_filters || [];
    $('drawerFilters').innerHTML = filters.length
      ? '<div class="filter-list">' + filters.map(function (f) {
          return '<span class="filter-item"><b>' + esc(f.label) + '</b> <small>' + esc(f.name) + '</small></span>';
        }).join('') + '</div>'
      : '<p class="muted-text">Nenhum filtro obrigatório detectado.</p>';

    renderDrawerColumns();

    $('drawerOverlay').classList.remove('hidden');
    $('drawer').classList.add('is-open');
    $('drawer').setAttribute('aria-hidden', 'false');
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
    state.openId = null;
    $('drawerOverlay').classList.add('hidden');
    $('drawer').classList.remove('is-open');
    $('drawer').setAttribute('aria-hidden', 'true');
  }

  function copyColumns() {
    var q = findQuery(state.openId);
    if (!q) return;
    var text = (q.columns || []).map(function (c) { return c.name; }).join('\n');
    if (!navigator.clipboard) { toast('Seu navegador não permite copiar automaticamente.'); return; }
    navigator.clipboard.writeText(text).then(function () { toast('Nomes das colunas copiados.'); });
  }

  /* ---------- Downloads ---------- */
  function downloadQuery(id) {
    var q = findQuery(id);
    if (!q) return;
    download(q.source_filename || (q.name + '.json'), JSON.stringify(q.raw_json, null, 2));
  }

  function downloadZip(list, zipName) {
    if (!list.length) { toast('Nenhuma consulta para baixar.'); return; }
    var zip = new JSZip(), used = {};
    list.forEach(function (q) {
      var base = (q.source_filename || (slug(q.name) + '.json')).replace(/\.json$/i, '');
      used[base] = (used[base] || 0) + 1;
      var name = used[base] > 1 ? base + '_' + used[base] + '.json' : base + '.json';
      zip.file(name, JSON.stringify(q.raw_json, null, 2));
    });
    zip.generateAsync({ type: 'blob' }).then(function (blob) {
      download(zipName, blob);
      toast(list.length + ' consulta(s) no ZIP.');
    });
  }

  /* ==========================================================================
     Somente admin
     ========================================================================== */

  /* ---------- Publicar para o GitHub ---------- */
  var PUBLISH_ERRORS = {
    github_not_configured: 'O GitHub ainda não foi configurado na Vercel (GITHUB_TOKEN e GITHUB_REPO).',
    github_auth: 'O token do GitHub foi recusado. Verifique se ele não expirou e se tem permissão de escrita em "Contents".',
    github_repo: 'Repositório não encontrado. Confira a variável GITHUB_REPO.',
    github_write: 'O GitHub recusou a gravação do arquivo.',
    github_read: 'Não foi possível ler o repositório no GitHub.',
    github_conflict: 'O arquivo mudou durante a publicação. Tente novamente.',
    invalid_library: 'A biblioteca enviada é inválida.',
    empty_not_confirmed: 'A publicação de uma biblioteca vazia precisa de confirmação.',
    bad_origin: 'Requisição recusada por segurança. Recarregue a página e tente de novo.',
    forbidden: 'Seu usuário não é administrador.'
  };

  function gzip(text) {
    var stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).blob();
  }

  function publish() {
    if (state.publishing) return;
    if (!state.dirty) { toast('Não há alterações para publicar.'); return; }
    if (!window.CompressionStream) { toast('Seu navegador é antigo para publicar. Atualize o Chrome, Edge ou Safari.'); return; }

    var empty = state.queries.length === 0;
    var question = empty
      ? 'ATENÇÃO: a biblioteca está VAZIA. Publicar vai apagar TODAS as consultas do site do time. Deseja continuar?'
      : 'Publicar ' + state.queries.length + ' consulta(s) para o time? O site atualiza em cerca de 1 minuto.';
    if (!window.confirm(question)) return;

    state.publishing = true;
    renderPublish();

    var finish = function () { state.publishing = false; renderPublish(); };

    gzip(JSON.stringify(state.queries)).then(function (blob) {
      var headers = { 'Content-Type': 'application/octet-stream' };
      if (empty) headers['X-Confirm-Empty'] = 'yes';
      return fetch('/api/admin/publish', { method: 'POST', headers: headers, body: blob });
    }).then(function (res) {
      if (res.status === 401) { window.location.replace('/login.html'); return null; }
      if (res.status === 404) throw new Error('A publicação só funciona no site publicado na Vercel.');
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (result) {
      if (!result) return;
      if (!result.ok) throw new Error(PUBLISH_ERRORS[result.data.error] || 'Não foi possível publicar (' + result.data.error + ').');
      state.dirty = false;
      saveDraft();
      toast('Publicado! O time verá as mudanças em cerca de 1 minuto, quando o deploy terminar.');
    }).catch(function (err) {
      toast(err.message);
    }).then(finish);
  }

  function discardDraft() {
    if (!window.confirm('Descartar o rascunho e recarregar a biblioteca publicada? As alterações não publicadas serão perdidas.')) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch (err) { /* ignora */ }
    state.dirty = false;
    state.selected = {};
    closeDrawer();
    fetchLibrary()
      .then(function (list) { state.queries = list; toast('Biblioteca recarregada.'); })
      .catch(function (err) { toast(err.message); })
      .then(renderAll);
  }

  /* ---------- Importação ---------- */
  function findIndex(item) {
    var idx = -1;
    state.queries.forEach(function (q, i) {
      if (q.id === item.id || (item.source_filename && q.source_filename === item.source_filename)) idx = i;
    });
    return idx;
  }

  // Une consultas à biblioteca: arquivos com o mesmo nome atualizam a consulta existente
  function mergeLibrary(list, keepData) {
    var added = 0, updated = 0;
    list.forEach(function (item) {
      var idx = findIndex(item);
      if (idx >= 0) {
        var old = state.queries[idx];
        if (!keepData) {
          // Reenvio do mesmo arquivo: atualiza o JSON, mantém o que já foi cadastrado
          item.id = old.id;
          item.categories = old.categories;
          item.description = old.description;
          item.created_at = old.created_at;
          item.primary_columns = old.primary_columns;
        }
        state.queries[idx] = item;
        updated++;
      } else {
        state.queries.unshift(item);
        added++;
      }
    });
    return { added: added, updated: updated };
  }

  function isLibrary(data) { return Array.isArray(data) && data.length && data[0] && data[0].raw_json; }

  function readJsonFile(file) {
    return file.text().then(function (text) {
      var data = JSON.parse(text);
      if (isLibrary(data)) return { library: data };
      return { query: parseQuery(data, file.name) };
    });
  }

  function readZip(file) {
    return JSZip.loadAsync(file).then(function (zip) {
      var entries = Object.keys(zip.files).filter(function (path) {
        return !zip.files[path].dir && /\.json$/i.test(path) && path.indexOf('__MACOSX') === -1;
      });
      var results = [];
      return entries.reduce(function (chain, path) {
        return chain.then(function () {
          return zip.files[path].async('string').then(function (text) {
            var name = path.split('/').pop();
            try {
              results.push({ query: parseQuery(JSON.parse(text), name) });
            } catch (err) {
              results.push({ error: name + ': ' + err.message });
            }
          });
        });
      }, Promise.resolve()).then(function () { return results; });
    });
  }

  function setStatus(text) { $('importStatus').textContent = text; }

  function handleBatch(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    setStatus('Lendo arquivos...');

    var jobs = files.map(function (file) {
      if (/\.zip$/i.test(file.name)) {
        return readZip(file).catch(function (err) { return [{ error: file.name + ': ' + err.message }]; });
      }
      return readJsonFile(file).then(function (r) { return [r]; })
        .catch(function (err) { return [{ error: file.name + ': ' + err.message }]; });
    });

    Promise.all(jobs).then(function (groups) {
      var results = [].concat.apply([], groups);
      var queries = [], errors = [], hasLibrary = false;

      results.forEach(function (r) {
        if (r.error) errors.push(r.error);
        else if (r.library) { hasLibrary = true; queries = queries.concat(r.library); }
        else if (r.query) queries.push(r.query);
      });

      $('batchFile').value = '';

      if (!queries.length) {
        setStatus(errors.length ? 'Nenhuma consulta válida. ' + errors[0] : 'Nenhum arquivo JSON encontrado.');
        return;
      }

      // Só uma consulta: segue para o formulário de detalhes
      if (queries.length === 1 && !hasLibrary) {
        $('importModal').close();
        openEditor(queries[0], true);
        return;
      }

      var r = mergeLibrary(queries, hasLibrary);
      changed();

      var msg = r.added + ' nova(s)';
      if (r.updated) msg += ', ' + r.updated + ' atualizada(s)';
      if (errors.length) msg += ', ' + errors.length + ' com erro';
      setStatus(msg + '. Use a seleção na lista para ajustar categorias em lote e depois clique em Publicar.');
      toast(msg + '.');
    }).catch(function (err) {
      setStatus('Erro ao ler os arquivos: ' + err.message);
    });
  }

  function handleSingleFile(file) {
    if (!file) return;
    file.text().then(function (text) {
      var q = parseQuery(JSON.parse(text), file.name);
      $('singleFile').value = '';
      setStatus('');
      $('importModal').close();
      openEditor(q, true);
    }).catch(function (err) {
      setStatus('Arquivo inválido: ' + err.message);
    });
  }

  function handlePaste() {
    var text = $('pasteJson').value.trim();
    if (!text) { setStatus('Cole o conteúdo do JSON da consulta.'); return; }
    try {
      var data = JSON.parse(text);
      var q = parseQuery(data, slug(data.name || 'consulta') + '.json');
      $('pasteJson').value = '';
      setStatus('');
      $('importModal').close();
      openEditor(q, true);
    } catch (err) {
      setStatus('JSON inválido: ' + err.message);
    }
  }

  function switchTab(name) {
    document.querySelectorAll('.tabs__btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.tab === name);
    });
    document.querySelectorAll('.tabs__panel').forEach(function (p) {
      p.classList.toggle('hidden', p.dataset.panel !== name);
    });
    setStatus('');
  }

  /* ---------- Edição / cadastro individual ---------- */
  function categoryPickerHtml(selected) {
    return CATEGORIES.map(function (cat) {
      var checked = selected.indexOf(cat.name) !== -1;
      return '<label class="check"><input type="checkbox" value="' + esc(cat.name) + '"' + (checked ? ' checked' : '') + '>' +
        '<span class="chip__dot" style="background:' + cat.color + '"></span>' + esc(cat.name) + '</label>';
    }).join('');
  }

  // Limita a quantidade de checkboxes marcados e atualiza o contador
  function limitChecks(containerId, max, counterId, suffix) {
    var boxes = Array.prototype.slice.call($(containerId).querySelectorAll('input[type="checkbox"]'));
    var checked = boxes.filter(function (b) { return b.checked; }).length;
    boxes.forEach(function (b) {
      var block = !b.checked && checked >= max;
      b.disabled = block;
      if (b.parentNode.classList.contains('check')) b.parentNode.classList.toggle('is-disabled', block);
    });
    $(counterId).textContent = checked + ' de ' + max + (suffix || '');
  }

  function checkedValues(containerId) {
    return Array.prototype.slice.call($(containerId).querySelectorAll('input[type="checkbox"]:checked')).map(function (i) { return i.value; });
  }

  function openEditor(q, isNew) {
    state.editing = { query: q, isNew: !!isNew };

    $('editTitle').textContent = isNew ? 'Nova consulta' : 'Editar consulta';
    $('editSummary').textContent = (q.source_filename || '') + ' · ' +
      (q.columns || []).length + ' colunas · ' + (q.required_filters || []).length + ' filtros detectados';
    $('editName').value = q.name;
    $('editDesc').value = q.description || '';
    $('editDelete').classList.toggle('hidden', !!isNew);

    $('catPicker').innerHTML = categoryPickerHtml(q.categories || []);

    var selected = q.primary_columns || [];
    $('colPicker').innerHTML = (q.columns || []).map(function (c) {
      var checked = selected.indexOf(c.name) !== -1;
      return '<div class="col-row">' +
        '<input type="checkbox" value="' + esc(c.name) + '"' + (checked ? ' checked' : '') + ' aria-label="Destacar ' + esc(c.name) + '">' +
        '<input type="text" data-label-for="' + esc(c.name) + '" value="' + esc(c.label) + '" maxlength="80">' +
        '<small>' + esc(c.name) + '</small>' +
      '</div>';
    }).join('') || '<span class="muted-text">Nenhuma coluna detectada.</span>';

    limitChecks('catPicker', MAX_CATEGORIES, 'catCount');
    limitChecks('colPicker', MAX_HIGHLIGHTS, 'colCount', ' em destaque');
    $('editModal').showModal();
  }

  function saveEditor() {
    var ctx = state.editing;
    if (!ctx) return;
    var q = ctx.query;

    var name = $('editName').value.trim();
    if (name.length < 3) { toast('Informe o nome da consulta.'); return; }

    var cols = checkedValues('colPicker');
    if (!cols.length && (q.columns || []).length) { toast('Marque ao menos uma coluna em destaque.'); return; }

    var cats = checkedValues('catPicker');
    q.name = name;
    q.categories = cats.length ? cats : ['Outros'];
    q.description = $('editDesc').value.trim();
    q.primary_columns = cols;

    // Nomes amigáveis das colunas
    $('colPicker').querySelectorAll('[data-label-for]').forEach(function (input) {
      var col = (q.columns || []).filter(function (c) { return c.name === input.dataset.labelFor; })[0];
      if (col && input.value.trim()) col.label = input.value.trim();
    });

    if (ctx.isNew) {
      var r = mergeLibrary([q], true);
      toast(r.updated ? 'Consulta existente atualizada. Clique em Publicar para enviar ao time.' : 'Consulta cadastrada. Clique em Publicar para enviar ao time.');
    } else {
      toast('Consulta salva. Clique em Publicar para enviar ao time.');
    }

    changed();
    if (state.openId === q.id) openDrawer(q.id);
    $('editModal').close();
  }

  function deleteEditing() {
    var ctx = state.editing;
    if (!ctx || ctx.isNew) return;
    var q = ctx.query;
    if (!window.confirm('Excluir a consulta "' + q.name + '"?')) return;
    state.queries = state.queries.filter(function (item) { return item.id !== q.id; });
    delete state.selected[q.id];
    closeDrawer();
    changed();
    $('editModal').close();
    toast('Consulta excluída.');
  }

  /* ---------- Ações em lote ---------- */
  function openBulkCategories() {
    var n = selectedIds().length;
    $('bulkModalSub').textContent = 'As categorias escolhidas substituem as atuais em ' + n + (n === 1 ? ' consulta.' : ' consultas.');
    $('bulkPicker').innerHTML = categoryPickerHtml([]);
    limitChecks('bulkPicker', MAX_CATEGORIES, 'bulkPickerCount');
    $('bulkModal').showModal();
  }

  function applyBulkCategories() {
    var cats = checkedValues('bulkPicker');
    if (!cats.length) { toast('Escolha ao menos uma categoria.'); return; }
    selectedIds().forEach(function (id) {
      var q = findQuery(id);
      if (q) q.categories = cats.slice();
    });
    changed();
    $('bulkModal').close();
    toast('Categorias aplicadas.');
  }

  function bulkDelete() {
    var ids = selectedIds();
    if (!window.confirm('Excluir ' + ids.length + ' consulta(s) selecionada(s)?')) return;
    state.queries = state.queries.filter(function (q) { return !state.selected[q.id]; });
    state.selected = {};
    changed();
    toast(ids.length + ' consulta(s) excluída(s).');
  }

  function clearSelection() {
    state.selected = {};
    renderList();
    renderBulk();
  }

  /* ---------- Eventos ---------- */
  function bindEvents() {
    on('btnLogout', 'click', logout);

    // Busca e filtros
    on('searchInput', 'input', function (e) { state.search = e.target.value; renderList(); });
    on('sortSelect', 'change', function (e) { state.sort = e.target.value; renderList(); });

    on('categoryChips', 'click', function (e) {
      var chip = e.target.closest('[data-category]');
      if (!chip) return;
      state.category = chip.dataset.category;
      renderAll();
    });

    // Lista
    on('queryList', 'click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var id = btn.dataset.id;
      if (btn.dataset.action === 'open') openDrawer(id);
      if (btn.dataset.action === 'download') downloadQuery(id);
      if (btn.dataset.action === 'fav') toggleFav(id);
    });

    on('queryList', 'change', function (e) {
      var box = e.target.closest('[data-select]');
      if (!box) return;
      if (box.checked) state.selected[box.dataset.select] = true;
      else delete state.selected[box.dataset.select];
      renderList();
      renderBulk();
    });

    on('selectAll', 'change', function (e) {
      visibleQueries().forEach(function (q) {
        if (e.target.checked) state.selected[q.id] = true;
        else delete state.selected[q.id];
      });
      renderList();
      renderBulk();
    });

    on('btnZipList', 'click', function () { downloadZip(visibleQueries(), 'consultas.zip'); });

    // Barra em lote
    on('bulkZip', 'click', function () {
      downloadZip(selectedIds().map(findQuery).filter(Boolean), 'consultas_selecionadas.zip');
    });
    on('bulkClear', 'click', clearSelection);

    // Drawer
    on('drawerClose', 'click', closeDrawer);
    on('drawerOverlay', 'click', closeDrawer);
    on('colSearch', 'input', renderDrawerColumns);
    on('copyCols', 'click', copyColumns);
    on('drawerDownload', 'click', function () { downloadQuery(state.openId); });
    on('drawerFav', 'click', function () {
      var q = findQuery(state.openId);
      if (!q) return;
      toggleFav(q.id);
      updateFavButton(q);
    });

    // Atalhos
    document.addEventListener('keydown', function (e) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === '/' && !typing && !document.querySelector('dialog[open]')) {
        e.preventDefault();
        $('searchInput').focus();
      }
      if (e.key === 'Escape' && state.openId && !document.querySelector('dialog[open]')) closeDrawer();
    });

    if (!ADMIN) return;

    // ----- Somente admin -----
    on('btnPublish', 'click', publish);
    on('btnDiscard', 'click', discardDraft);
    on('btnImport', 'click', function () { switchTab('single'); $('importModal').showModal(); });

    on('drawerEdit', 'click', function () {
      var q = findQuery(state.openId);
      if (q) openEditor(q, false);
    });

    on('bulkCategories', 'click', openBulkCategories);
    on('bulkApply', 'click', applyBulkCategories);
    on('bulkPicker', 'change', function () { limitChecks('bulkPicker', MAX_CATEGORIES, 'bulkPickerCount'); });
    on('bulkDelete', 'click', bulkDelete);

    document.querySelectorAll('.tabs__btn').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.tab); });
    });
    on('singleFile', 'change', function (e) { handleSingleFile(e.target.files[0]); });
    on('btnPaste', 'click', handlePaste);
    on('batchFile', 'change', function (e) { handleBatch(e.target.files); });

    [['batchDrop', handleBatch], ['singleDrop', function (files) { handleSingleFile(files[0]); }]].forEach(function (pair) {
      var zone = $(pair[0]);
      ['dragenter', 'dragover'].forEach(function (evt) {
        zone.addEventListener(evt, function (e) { e.preventDefault(); zone.classList.add('is-over'); });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        zone.addEventListener(evt, function (e) { e.preventDefault(); zone.classList.remove('is-over'); });
      });
      zone.addEventListener('drop', function (e) { pair[1](e.dataTransfer.files); });
    });

    on('catPicker', 'change', function () { limitChecks('catPicker', MAX_CATEGORIES, 'catCount'); });
    on('colPicker', 'change', function () { limitChecks('colPicker', MAX_HIGHLIGHTS, 'colCount', ' em destaque'); });
    on('editSave', 'click', saveEditor);
    on('editDelete', 'click', deleteEditing);

    // Fechar modais (× / Cancelar / clique fora)
    document.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () { $(btn.dataset.close).close(); });
    });
    document.querySelectorAll('dialog').forEach(function (dlg) {
      dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    });

    // Avisa antes de sair com alterações não publicadas
    window.addEventListener('beforeunload', function (e) {
      if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    init();
  });
})();
