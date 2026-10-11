/* ==========================================================================
   QueryHub | Acessos e permissões (somente no painel admin)
   Lista quem entra, quem administra e quem está bloqueado, e grava as mudanças
   em data/access.json no GitHub (pela rota /api/admin/access).
   ========================================================================== */
(function () {
  'use strict';

  var QH = window.QH;
  if (!QH || !QH.ADMIN) return;
  if (window.QHBuild) window.QHBuild.report('access', '3.4.0');

  var $ = QH.$, on = QH.on, esc = QH.esc, normalize = QH.normalize, toast = QH.toast;
  var openModal = QH.openModal, closeModal = QH.closeModal;

  var ROLE_LABEL = { admin: 'Administrador', viewer: 'Consulta', blocked: 'Bloqueado' };
  var EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

  var ERRORS = {
    access_unavailable: 'Não consegui ler a lista de acessos no GitHub agora. Tente de novo em instantes.',
    github_not_configured: 'O GitHub não está configurado na Vercel (GITHUB_TOKEN e GITHUB_REPO), então não dá para salvar.',
    github_auth: 'O token do GitHub foi recusado. Confira se ele não expirou e se tem permissão de escrita em "Contents".',
    github_write: 'O GitHub recusou a gravação do arquivo de acessos.',
    stale: 'Outra pessoa alterou os acessos enquanto você editava. Recarregue a lista e refaça a mudança.',
    invalid_email: 'Há um e-mail inválido na lista.',
    duplicate_email: 'Há um e-mail repetido na lista.',
    invalid_role: 'Há uma permissão inválida na lista.',
    owner_protected: 'Esse e-mail é administrador fixo (definido na Vercel) e não pode ser alterado aqui.',
    self_demote: 'Você não pode tirar o seu próprio acesso de administrador. Peça a outro administrador.',
    no_admin: 'É preciso ter pelo menos um administrador.',
    too_many: 'A lista tem pessoas demais (o limite é 300).',
    bad_origin: 'Requisição recusada por segurança. Recarregue a página e tente de novo.',
    forbidden: 'Seu usuário não é administrador.'
  };

  var acc = null;       // o que veio do servidor
  var model = null;     // o que está sendo editado: { mode, users }
  var saving = false;

  function clone(u) { return { email: u.email, name: u.name || '', role: u.role, added_by: u.added_by || '', added_at: u.added_at || 0 }; }
  function signature(m) { return JSON.stringify([m.mode, m.users.map(function (u) { return [u.email, u.name, u.role]; })]); }
  function isDirty() { return !!acc && signature(model) !== acc.orig; }

  function formatDate(ts) {
    if (!ts) return '';
    var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
  }

  function setError(text) { $('accError').textContent = text || ''; }

  /* ---------- Carregar ---------- */
  function load() {
    return fetch('/api/admin/access', { cache: 'no-store' }).then(function (res) {
      if (res.status === 401) { window.location.replace('/login.html'); return null; }
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (r) {
      if (!r) return false;
      if (!r.ok) throw new Error(ERRORS[r.data.error] || 'Não foi possível carregar os acessos.');
      acc = r.data;
      acc.orig = signature({ mode: acc.mode, users: acc.users });
      model = { mode: acc.mode, users: acc.users.map(clone) };
      setError('');
      $('accReload').classList.add('hidden');
      render();
      return true;
    });
  }

  function openAccess() {
    load().then(function (ok) { if (ok) openModal($('accessModal')); }).catch(function (err) { toast(err.message); });
  }

  /* ---------- Desenho ---------- */
  function counts() {
    var a = acc.owners.length, v = 0, b = 0;
    model.users.forEach(function (u) { if (u.role === 'admin') a++; else if (u.role === 'viewer') v++; else b++; });
    return { admins: a, viewers: v, blocked: b };
  }

  function renderMode() {
    var list = model.mode === 'list';
    document.querySelectorAll('input[name="accMode"]').forEach(function (r) {
      r.checked = r.value === (acc.forced ? 'list' : model.mode);
      r.disabled = !!acc.forced || !acc.canSave;
    });
    $('accDomain').textContent = acc.domain;
    var note = $('accForced');
    note.classList.toggle('hidden', !acc.forced);
    note.textContent = acc.forced ? 'A variável ALLOWED_EMAILS da Vercel está forçando o modo "somente pessoas da lista". Para escolher aqui, remova essa variável na Vercel.' : '';
    $('accModeInfo').textContent = list || acc.forced
      ? 'Só entram as pessoas desta lista (como Consulta ou Administrador) e os administradores fixos.'
      : 'Qualquer conta @' + acc.domain + ' entra para consultar. A lista abaixo serve para dar administração, liberar alguém de fora do domínio ou bloquear alguém.';
  }

  function rowHtml(u, i) {
    var self = !acc.youOwner && u.email === acc.you;
    var tip = self ? ' title="Você não pode alterar o seu próprio acesso. Peça a outro administrador."' : '';
    var meta = u.added_by ? 'por ' + esc(u.added_by.split('@')[0]) + (u.added_at ? ' · ' + formatDate(u.added_at) : '') : '';
    return '<div class="acc-row" data-i="' + i + '">' +
      '<input type="text" class="acc-name" data-i="' + i + '" value="' + esc(u.name) + '" maxlength="80" placeholder="Nome" aria-label="Nome de ' + esc(u.email) + '">' +
      '<span class="acc-email">' + esc(u.email) + (self ? ' <span class="acc-tag">você</span>' : '') + '</span>' +
      '<select class="acc-role acc-role--' + u.role + '" data-i="' + i + '" aria-label="Permissão de ' + esc(u.email) + '"' + (self ? ' disabled' : '') + tip + '>' +
        ['admin', 'viewer', 'blocked'].map(function (r) { return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + ROLE_LABEL[r] + '</option>'; }).join('') +
      '</select>' +
      '<span class="acc-meta">' + meta + '</span>' +
      '<button type="button" class="icon-btn acc-del" data-i="' + i + '" aria-label="Remover ' + esc(u.email) + '"' + (self ? ' disabled' : '') + tip + '>×</button>' +
    '</div>';
  }

  function renderList() {
    var term = normalize($('accFilter').value), html = '';
    acc.owners.forEach(function (email) {
      if (term && normalize(email).indexOf(term) === -1) return;
      html += '<div class="acc-row acc-row--owner">' +
        '<span class="acc-name acc-name--static">—</span>' +
        '<span class="acc-email">' + esc(email) + (email === acc.you ? ' <span class="acc-tag">você</span>' : '') + '</span>' +
        '<span class="acc-role acc-role--admin acc-role--static">Administrador</span>' +
        '<span class="acc-meta">Fixo: definido na Vercel</span>' +
        '<span></span></div>';
    });
    model.users.forEach(function (u, i) {
      if (term && normalize(u.name + ' ' + u.email).indexOf(term) === -1) return;
      html += rowHtml(u, i);
    });
    $('accList').innerHTML = html || '<p class="muted-text acc-empty">Nenhuma pessoa encontrada.</p>';
  }

  function renderFooter() {
    var dirty = isDirty();
    $('accSave').disabled = !dirty || saving || !acc.canSave;
    $('accSave').textContent = saving ? 'Salvando…' : 'Salvar acessos';
    var status = $('accStatus');
    status.classList.toggle('is-dirty', dirty);
    status.textContent = !acc.canSave ? 'O GitHub não está configurado: só leitura.' : (dirty ? 'Alterações não salvas' : 'Tudo salvo');
    var c = counts();
    $('accSummary').textContent = c.admins + (c.admins === 1 ? ' administrador' : ' administradores') + ' · ' + c.viewers + ' de consulta · ' + c.blocked + (c.blocked === 1 ? ' bloqueado' : ' bloqueados');
  }

  function render() {
    renderMode();
    renderList();
    renderFooter();
  }

  /* ---------- Edição ---------- */
  function addPerson() {
    var email = $('accNewEmail').value.trim().toLowerCase(), name = $('accNewName').value.trim(), role = $('accNewRole').value;
    var err = $('accAddError');
    err.textContent = '';
    if (!EMAIL_RE.test(email)) { err.textContent = 'Digite um e-mail válido.'; $('accNewEmail').focus(); return; }
    if (acc.owners.indexOf(email) !== -1) { err.textContent = 'Esse e-mail já é administrador fixo (definido na Vercel).'; return; }
    if (model.users.some(function (u) { return u.email === email; })) { err.textContent = 'Esse e-mail já está na lista. Altere a permissão dele abaixo.'; return; }
    if (model.users.length >= 300) { err.textContent = 'A lista chegou ao limite de 300 pessoas.'; return; }
    model.users.unshift({ email: email, name: name, role: role, added_by: acc.you, added_at: Date.now() });
    $('accNewEmail').value = ''; $('accNewName').value = '';
    $('accFilter').value = '';
    render();
    $('accNewEmail').focus();
  }

  function save() {
    if (!isDirty() || saving) return;
    if (model.mode === 'list' && acc.mode !== 'list' && !window.confirm('No modo "somente pessoas da lista", quem não estiver na lista perde o acesso em até 1 minuto. Continuar?')) return;
    var blockedNow = model.users.filter(function (u) { return u.role === 'blocked'; }).length;
    saving = true; setError(''); renderFooter();

    fetch('/api/admin/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: model.mode, sha: acc.sha, users: model.users.map(function (u) { return { email: u.email, name: u.name, role: u.role }; }) })
    }).then(function (res) {
      if (res.status === 401) { window.location.replace('/login.html'); return null; }
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (r) {
      if (!r) return;
      if (!r.ok) {
        var e = new Error(ERRORS[r.data.error] || 'Não foi possível salvar (' + (r.data.error || 'erro') + ').');
        e.code = r.data.error; e.email = r.data.email;
        throw e;
      }
      acc = r.data;
      acc.orig = signature({ mode: acc.mode, users: acc.users });
      model = { mode: acc.mode, users: acc.users.map(clone) };
      render();
      toast('Acessos salvos. Valem em até 1 minuto, em todos os computadores.');
    }).catch(function (err) {
      setError(err.message + (err.email ? ' (' + err.email + ')' : ''));
      $('accReload').classList.toggle('hidden', err.code !== 'stale');
    }).then(function () { saving = false; if (acc) renderFooter(); });
  }

  /* ---------- Eventos ---------- */
  function bind() {
    on('menuAccess', 'click', openAccess);
    on('accAdd', 'click', addPerson);
    on('accNewEmail', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addPerson(); } });
    on('accSave', 'click', save);
    on('accReload', 'click', function () { load().catch(function (err) { toast(err.message); }); });
    on('accFilter', 'input', function () { if (acc) renderList(); });

    document.querySelectorAll('input[name="accMode"]').forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked && model) { model.mode = r.value; render(); } });
    });

    on('accList', 'input', function (e) {
      var el = e.target.closest('.acc-name');
      if (!el || !model) return;
      model.users[Number(el.getAttribute('data-i'))].name = el.value;
      renderFooter();
    });
    on('accList', 'change', function (e) {
      var el = e.target.closest('.acc-role');
      if (!el || !model) return;
      var u = model.users[Number(el.getAttribute('data-i'))];
      u.role = el.value;
      el.className = 'acc-role acc-role--' + u.role;
      renderFooter();
    });
    on('accList', 'click', function (e) {
      var del = e.target.closest('.acc-del');
      if (!del || del.disabled || !model) return;
      model.users.splice(Number(del.getAttribute('data-i')), 1);
      render();
    });

    // Fechar com alterações não salvas pede confirmação
    $('accessModal')._beforeClose = function () {
      return !isDirty() || window.confirm('Há alterações não salvas nos acessos. Fechar mesmo assim?');
    };
  }

  QH.hooks.bindAccess = bind;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();

  QH.access = { open: openAccess, isDirty: isDirty };
})();
