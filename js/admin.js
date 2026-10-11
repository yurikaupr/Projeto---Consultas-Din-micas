/* ==========================================================================
   QueryHub | Painel admin
   Cadastro, validação de arquivos, relatório, edição, desfazer e publicação.
   Depende de js/app.js (window.QH).
   ========================================================================== */
(function () {
  'use strict';

  if (window.QHBuild) window.QHBuild.report('admin', '3.4.0');

  var QH = window.QH;
  if (!QH || !QH.ADMIN) return;

  var $ = QH.$, on = QH.on, esc = QH.esc, normalize = QH.normalize, slug = QH.slug, toast = QH.toast, download = QH.download;
  var findQuery = QH.findQuery, openModal = QH.openModal, closeModal = QH.closeModal, state = QH.state;

  state.report = null;       // último relatório de importação
  state.reportTab = 'erro';
  state.warnById = {};       // avisos por consulta (mostrados no editor)
  state.editing = null;
  state.publishing = false;

  /* ---------- Sugestão de categoria e nomes de colunas ---------- */
  var ACRONYMS = { sku: 'SKU', id: 'ID', nf: 'NF', cpf: 'CPF', cnpj: 'CNPJ', uf: 'UF', cep: 'CEP' };

  /* Palavras do nome da consulta usadas para sugerir categorias na importação em lote.
     O padrão exige início de palavra (\b) para não casar no meio de outras, como "nfe" em "conferência". */
  var CATEGORY_HINTS = [
    { name: 'Clientes',    re: /\b(?:cliente|pessoa|contato|cadastro)/ },
    { name: 'Pedidos',     re: /\b(?:pedido|venda|carrinho|entrega|rastreio|frete)/ },
    { name: 'Faturamento', re: /\b(?:faturamento|fatura|nota fiscal|\bnf\b|nfe)/ },
    { name: 'Marketplace', re: /\b(?:marketplace|amazon|shopee|magalu|mercado livre|americanas|\bb2w\b)/ },
    { name: 'Financeiro',  re: /\b(?:financeiro|pagamento|recebiv|conciliacao|boleto|cartao|repasse)/ },
    { name: 'Produtos',    re: /\b(?:produto|\bsku\b|marca|derivacao|categoria)/ },
    { name: 'Estoque',     re: /\b(?:estoque|saldo|deposito)/ },
    { name: 'Preço',       re: /\b(?:preco|tabela de|promocao|desconto)/ }
  ];

  function humanize(name, title) {
    if (title && String(title).trim()) return String(title).trim();
    return String(name || '')
      .replace(/^:/, '')
      .split(/[_\s]+/)
      .filter(Boolean)
      .map(function (w) { return ACRONYMS[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); })
      .join(' ');
  }

  function guessCategories(name) {
    var text = normalize(name);
    var found = CATEGORY_HINTS
      .filter(function (hint) { return hint.re.test(text); })
      .map(function (hint) { return hint.name; })
      .slice(0, 2);
    return found.length ? found : ['Outros'];
  }

  /* ==========================================================================
     Validação de arquivos
     Cada problema tem um código, uma gravidade (erro, aviso, info, ignorado),
     o que aconteceu (detail) e como resolver (hint).
     ========================================================================== */
  var MAX_FILE_CHARS = 8000000;     // acima disso o arquivo é recusado
  var WARN_FILE_CHARS = 1000000;    // acima disso há aviso de peso
  var WARN_QUERY_CHARS = 200000;
  var WARN_COLUMNS = 250;

  var ISSUES = {
    /* ----- Arquivo ----- */
    ARQ_VAZIO:    { g: 'Arquivo', sev: 'erro', title: 'O arquivo está vazio', meaning: 'Não há nada dentro do arquivo. Ele foi salvo sem conteúdo.', hint: 'Exporte a consulta de novo pela plataforma e envie o arquivo novo. Se o arquivo veio de e-mail ou de chat, peça para a pessoa reenviar.' },
    ARQ_GRANDE:   { g: 'Arquivo', sev: 'erro', title: 'O arquivo é grande demais', meaning: 'O arquivo passa de 8 MB. Uma consulta normal tem poucos KB, então provavelmente não é o arquivo certo (pode ser um backup ou uma planilha de dados).', hint: 'Confira se escolheu o arquivo certo e envie só os arquivos de consulta.' },
    ARQ_LEITURA:  { g: 'Arquivo', sev: 'erro', title: 'Não consegui abrir o arquivo', meaning: 'O navegador não conseguiu ler o arquivo. Isso acontece, por exemplo, quando ele está numa pasta sincronizada (OneDrive, Google Drive) e ainda não foi baixado para o computador.', hint: 'Copie o arquivo para uma pasta do seu computador (como Documentos) e envie de novo.' },
    ARQ_ENCODING: { g: 'Arquivo', sev: 'aviso', title: 'Alguns acentos ficaram trocados por �', meaning: 'O arquivo foi salvo de um jeito que perdeu alguns acentos. A consulta foi importada, mas nomes e comentários podem aparecer com letras erradas.', hint: 'Abra a consulta e confira o nome. Se estiver estranho, corrija no editor ou exporte de novo pela plataforma.' },
    ARQ_PESADO:   { g: 'Arquivo', sev: 'aviso', title: 'O arquivo é maior que o normal', meaning: 'O arquivo passa de 1 MB. Ele foi importado, mas isso é incomum para uma consulta.', hint: 'Confira se é essa consulta mesmo. Se estiver tudo certo, pode ignorar este aviso.' },
    ARQ_IGNORADO: { g: 'Arquivo', sev: 'ignorado', title: 'Arquivo que não é uma consulta (pulado)', meaning: 'Só leio arquivos .json e .zip. Este foi pulado e não atrapalha nada.', hint: 'Nada a fazer. Se ele deveria ser uma consulta, exporte-a em formato .json e envie de novo.' },
    ARQ_SISTEMA:  { g: 'Arquivo', sev: 'ignorado', title: 'Arquivo automático do computador (pulado)', meaning: 'O Mac e o Windows criam sozinhos arquivos como .DS_Store, Thumbs.db e a pasta __MACOSX. Não são consultas.', hint: 'Nada a fazer.' },

    /* ----- ZIP ----- */
    ZIP_INVALIDO:   { g: 'ZIP', sev: 'erro', title: 'Não consegui abrir o ZIP', meaning: 'O arquivo .zip está corrompido, incompleto ou não é um ZIP de verdade. Costuma acontecer quando o download é interrompido.', hint: 'Baixe ou compacte de novo. Se puder, extraia o ZIP no computador e envie os arquivos .json de dentro.' },
    ZIP_PROTEGIDO:  { g: 'ZIP', sev: 'erro', title: 'O ZIP tem senha', meaning: 'O navegador não consegue abrir ZIPs protegidos por senha.', hint: 'Extraia o ZIP usando a senha, compacte de novo sem senha e envie o novo ZIP.' },
    ZIP_SEM_JSON:   { g: 'ZIP', sev: 'erro', title: 'O ZIP não tem consultas dentro', meaning: 'Consegui abrir o ZIP, mas não encontrei nenhum arquivo de consulta (.json) nele.', hint: 'Confira se compactou os arquivos certos. Os arquivos de consulta terminam em .json.' },
    ZIP_ANINHADO:   { g: 'ZIP', sev: 'ignorado', title: 'ZIP dentro de outro ZIP (pulado)', meaning: 'Há um ZIP dentro do ZIP e eu não abro o de dentro.', hint: 'Extraia o ZIP de dentro e envie os arquivos de consulta dele.' },

    /* ----- Arquivo com defeito ----- */
    JSON_TRUNCADO:        { g: 'Arquivo com defeito', sev: 'erro', title: 'O arquivo está incompleto', meaning: 'O arquivo termina no meio, como se tivesse sido cortado. Normalmente acontece quando o download ou a cópia é interrompido.', hint: 'Exporte a consulta de novo pela plataforma e envie o arquivo novo.' },
    JSON_VIRGULA:         { g: 'Arquivo com defeito', sev: 'erro', title: 'Tem uma vírgula sobrando no arquivo', meaning: 'Existe uma vírgula antes de um fechamento (} ou ]). O arquivo precisa estar perfeito para eu conseguir ler.', hint: 'O mais fácil é exportar a consulta de novo pela plataforma. Se editou o arquivo à mão, apague a vírgula no ponto marcado abaixo.' },
    JSON_ASPAS:           { g: 'Arquivo com defeito', sev: 'erro', title: 'O arquivo usa aspas simples (\')', meaning: 'Os textos do arquivo precisam estar entre aspas duplas ("). Isso costuma acontecer quando o arquivo foi digitado ou editado à mão.', hint: 'Exporte a consulta de novo pela plataforma, em vez de editar o arquivo.' },
    JSON_CHAVE_SEM_ASPAS: { g: 'Arquivo com defeito', sev: 'erro', title: 'Há nomes sem aspas no arquivo', meaning: 'Alguns nomes dentro do arquivo (como name ou query) precisam estar entre aspas duplas e não estão.', hint: 'Exporte a consulta de novo pela plataforma, em vez de editar o arquivo.' },
    JSON_FORMATO_JS:      { g: 'Arquivo com defeito', sev: 'erro', title: 'O arquivo parece escrito à mão', meaning: 'O conteúdo mistura aspas simples, nomes sem aspas e vírgulas sobrando, como se tivesse sido digitado e não exportado.', hint: 'Exporte a consulta de novo pela plataforma e envie o arquivo novo.' },
    JSON_COMENTARIO:      { g: 'Arquivo com defeito', sev: 'erro', title: 'O arquivo tem comentários', meaning: 'Comentários (// ou /* */) não são permitidos neste tipo de arquivo.', hint: 'Apague os comentários ou exporte a consulta de novo pela plataforma.' },
    JSON_HTML:            { g: 'Arquivo com defeito', sev: 'erro', title: 'Isso é uma página da internet, não uma consulta', meaning: 'O arquivo é uma página da web salva com final .json. Geralmente acontece quando a sua sessão na plataforma expirou e ela baixou a tela de login no lugar da consulta.', hint: 'Entre de novo na plataforma e exporte a consulta outra vez.' },
    JSON_SQL_PURO:        { g: 'Arquivo com defeito', sev: 'erro', title: 'O arquivo só tem o SQL', meaning: 'Este arquivo parece ter só o texto do SQL. Eu preciso do arquivo exportado da consulta dinâmica, que traz também a lista de colunas e filtros.', hint: 'Exporte a consulta pela plataforma (exportar consulta dinâmica) e envie esse arquivo.' },
    JSON_TEXTO_LIVRE:     { g: 'Arquivo com defeito', sev: 'erro', title: 'O arquivo não parece uma consulta', meaning: 'O conteúdo parece um texto comum, como um bloco de notas, e não uma consulta exportada.', hint: 'Confira se é o arquivo certo. Uma consulta exportada começa com o símbolo {.' },
    JSON_MULTIPLOS:       { g: 'Arquivo com defeito', sev: 'erro', title: 'Há mais de uma consulta colada no mesmo arquivo', meaning: 'Várias consultas foram coladas uma depois da outra dentro de um único arquivo, do jeito errado.', hint: 'Separe cada consulta em um arquivo próprio, ou envie todos os arquivos juntos dentro de um ZIP.' },
    JSON_QUEBRA_LINHA:    { g: 'Arquivo com defeito', sev: 'erro', title: 'Uma quebra de linha está no lugar errado', meaning: 'O texto do SQL tem uma quebra de linha "solta" no arquivo, e isso impede a leitura.', hint: 'Exporte a consulta de novo pela plataforma. Evite abrir e salvar o arquivo em outro programa.' },
    JSON_ESCAPE:          { g: 'Arquivo com defeito', sev: 'erro', title: 'Uma barra invertida (\\) está atrapalhando', meaning: 'Há uma barra invertida dentro de um texto (comum em caminhos como C:\\pasta) e ela precisaria estar escrita de outro jeito.', hint: 'Exporte a consulta de novo pela plataforma, ou troque cada \\ por \\\\ no ponto marcado.' },
    JSON_VALOR_INVALIDO:  { g: 'Arquivo com defeito', sev: 'erro', title: 'O arquivo tem valores que não consigo ler', meaning: 'Há valores como "undefined", "NaN" ou "Infinity", que não existem neste tipo de arquivo.', hint: 'Exporte a consulta de novo pela plataforma. Se editou o arquivo à mão, apague esse valor.' },
    JSON_SINTAXE:         { g: 'Arquivo com defeito', sev: 'erro', title: 'O arquivo está com defeito e não consegui entender', meaning: 'O conteúdo não está escrito no formato certo e o problema não se encaixa nos casos mais comuns.', hint: 'Veja o trecho marcado abaixo. O mais seguro é exportar a consulta de novo pela plataforma.' },

    /* ----- Consulta incompleta ----- */
    RAIZ_TIPO:        { g: 'Consulta incompleta', sev: 'erro', title: 'O arquivo não parece uma consulta', meaning: 'O conteúdo é só um número, um texto solto ou um "sim/não", e não uma consulta completa.', hint: 'Confira se é o arquivo certo. Uma consulta exportada tem nome, SQL e lista de colunas.' },
    RAIZ_LISTA:       { g: 'Consulta incompleta', sev: 'erro', title: 'O arquivo é uma lista de outras coisas', meaning: 'Eu esperava uma consulta (ou uma lista de consultas), mas os itens do arquivo não parecem consultas.', hint: 'Confira se é o arquivo certo. Se for um arquivo com várias consultas, cada uma precisa ter o SQL e a lista de colunas.' },
    RAIZ_ENCAPSULADA: { g: 'Consulta incompleta', sev: 'erro', title: 'A consulta está dentro de uma "caixa" extra', meaning: 'A consulta está lá, mas guardada dentro de outra seção do arquivo, e não no começo dele.', hint: 'Exporte a consulta de novo pela plataforma, ou envie o arquivo sem a seção extra.' },
    BIBLIOTECA_ITEM:  { g: 'Consulta incompleta', sev: 'erro', title: 'Um item do arquivo de backup está quebrado', meaning: 'Num arquivo de backup do QueryHub, um dos itens está sem o conteúdo da consulta.', hint: 'Corrija ou apague o item indicado e envie o arquivo de novo.' },
    QUERY_AUSENTE:    { g: 'Consulta incompleta', sev: 'erro', title: 'O arquivo não traz o SQL da consulta', meaning: 'Procurei o texto do SQL dentro do arquivo e não encontrei. Sem ele não dá para importar.', hint: 'Confira se este é o arquivo exportado da consulta dinâmica. Se tiver certeza, exporte de novo pela plataforma.' },
    QUERY_TIPO:       { g: 'Consulta incompleta', sev: 'erro', title: 'O SQL da consulta veio num formato estranho', meaning: 'O SQL deveria ser um texto, mas veio como número, lista ou outra coisa.', hint: 'Exporte a consulta de novo pela plataforma e envie o arquivo novo.' },
    QUERY_VAZIA:      { g: 'Consulta incompleta', sev: 'erro', title: 'O SQL da consulta está em branco', meaning: 'O espaço do SQL existe no arquivo, mas está vazio.', hint: 'Abra a consulta na plataforma, confira se o SQL está salvo e exporte de novo.' },
    FIELD_AUSENTE:    { g: 'Consulta incompleta', sev: 'erro', title: 'O arquivo não traz a lista de colunas e filtros', meaning: 'Sem essa lista eu não consigo mostrar as colunas da consulta para o time.', hint: 'Confira se este é o arquivo exportado da consulta dinâmica. Se tiver certeza, exporte de novo pela plataforma.' },
    FIELD_TIPO:       { g: 'Consulta incompleta', sev: 'erro', title: 'A lista de colunas e filtros veio num formato estranho', meaning: 'Essa lista deveria ser uma lista de itens, mas veio de outro jeito.', hint: 'Exporte a consulta de novo pela plataforma e envie o arquivo novo.' },

    /* ----- Pontos de atenção (a consulta foi importada) ----- */
    LISTA_EXPANDIDA:    { g: 'Pontos de atenção', sev: 'info', title: 'O arquivo tinha várias consultas juntas', meaning: 'Cada uma virou uma consulta separada no QueryHub.', hint: 'Dê uma olhada nos nomes. Cada consulta tem o seu próprio botão de baixar.' },
    NOME_AUSENTE:       { g: 'Pontos de atenção', sev: 'aviso', title: 'A consulta está sem nome', meaning: 'O arquivo não informa o nome da consulta, então usei o nome do arquivo no lugar.', hint: 'Abra a consulta e escreva um nome claro para o time (botão Editar).' },
    NOME_TIPO:          { g: 'Pontos de atenção', sev: 'aviso', title: 'O nome da consulta veio num formato estranho', meaning: 'O nome deveria ser um texto, então usei o nome do arquivo no lugar.', hint: 'Abra a consulta e escreva um nome claro para o time (botão Editar).' },
    NOME_CURTO:         { g: 'Pontos de atenção', sev: 'aviso', title: 'O nome da consulta é muito curto', meaning: 'Nomes com menos de 3 letras dificultam a busca e o editor não os aceita.', hint: 'Abra a consulta e escreva um nome que descreva o que ela entrega.' },
    NOME_LONGO:         { g: 'Pontos de atenção', sev: 'aviso', title: 'O nome da consulta é muito longo', meaning: 'Nomes com mais de 160 letras quebram o visual dos cards.', hint: 'Abra a consulta e deixe o nome mais curto.' },
    FIELD_VAZIO:        { g: 'Pontos de atenção', sev: 'aviso', title: 'A consulta não tem colunas nem filtros cadastrados', meaning: 'A consulta foi importada, mas o card vai aparecer sem nenhuma coluna para o time conferir.', hint: 'Confira se a exportação saiu completa. Se preferir, exporte de novo pela plataforma.' },
    SEM_COLUNAS:        { g: 'Pontos de atenção', sev: 'aviso', title: 'A consulta não mostra colunas', meaning: 'Existem campos cadastrados, mas nenhum é uma coluna de resultado (só filtros ou outros itens). É normal em rotinas que não devolvem dados.', hint: 'Se esta consulta deveria devolver dados, confira a exportação na plataforma. Se for uma rotina, pode ignorar.' },
    FIELD_ITEM_INVALIDO:{ g: 'Pontos de atenção', sev: 'aviso', title: 'Alguns itens da lista de colunas estavam quebrados', meaning: 'Esses itens estavam em branco ou ilegíveis e foram ignorados. Eles não aparecem como colunas.', hint: 'Compare com a consulta na plataforma. Se faltar alguma coluna, exporte de novo.' },
    CAMPO_SEM_NOME:     { g: 'Pontos de atenção', sev: 'aviso', title: 'Algumas colunas estão sem nome', meaning: 'Colunas sem nome foram ignoradas e não aparecem para o time.', hint: 'Compare com a consulta na plataforma. Se faltar alguma coluna, exporte de novo.' },
    CAMPO_SEM_TIPO:     { g: 'Pontos de atenção', sev: 'aviso', title: 'Alguns campos não dizem se são colunas ou filtros', meaning: 'Sem essa informação eu não os mostro como colunas.', hint: 'Se esses itens deveriam aparecer como colunas, exporte a consulta de novo pela plataforma.' },
    CAMPO_TIPO_INVALIDO:{ g: 'Pontos de atenção', sev: 'aviso', title: 'Alguns campos têm uma indicação que não entendo', meaning: 'A indicação de coluna ou filtro desses campos veio escrita de um jeito que não reconheço, então eles não aparecem como colunas.', hint: 'Se esses itens deveriam aparecer como colunas, exporte a consulta de novo pela plataforma.' },
    COLUNA_DUPLICADA:   { g: 'Pontos de atenção', sev: 'aviso', title: 'Há colunas repetidas', meaning: 'Duas ou mais colunas têm o mesmo nome. Mantive só a primeira de cada.', hint: 'Isso costuma indicar a mesma coluna listada duas vezes no SQL. Vale conferir com quem criou a consulta.' },
    MUITAS_COLUNAS:     { g: 'Pontos de atenção', sev: 'aviso', title: 'A consulta tem muitas colunas (mais de 250)', meaning: 'Funciona, mas é raro uma consulta devolver tantas colunas.', hint: 'Confira se é essa consulta mesmo. Se estiver certo, pode ignorar.' },
    PARAM_SEM_CAMPO:    { g: 'Pontos de atenção', sev: 'aviso', title: 'O SQL usa um filtro que não foi descrito', meaning: 'O SQL tem um filtro (como :data_inicio) que não aparece na lista de filtros da consulta. Vou tratá-lo como filtro de data.', hint: 'Abra os detalhes da consulta e confira se o filtro está certo. Se o tipo estiver errado, avise quem criou a consulta.' },
    PARAM_NAO_USADO:    { g: 'Pontos de atenção', sev: 'aviso', title: 'Há um filtro cadastrado que o SQL não usa', meaning: 'O filtro está na lista, mas o SQL não o utiliza. Pode ser sobra de uma edição antiga.', hint: 'Confira com quem criou a consulta se o filtro ainda faz sentido.' },
    PARAM_EM_TEXTO:     { g: 'Pontos de atenção', sev: 'aviso', title: 'Um "filtro" pode ser só um pedaço de texto', meaning: 'Encontrei algo como :nome dentro de um texto ou de um comentário do SQL e contei como filtro. Pode ser engano.', hint: 'Se não for um filtro de verdade, pode ignorar este aviso.' },
    QUERY_SEM_COMANDO:  { g: 'Pontos de atenção', sev: 'aviso', title: 'Não encontrei um comando SQL conhecido', meaning: 'Não achei SELECT, WITH, CALL ou outro comando SQL comum no texto da consulta.', hint: 'Abra os detalhes e confira se o SQL é esse mesmo.' },
    COMANDO_ESCRITA:    { g: 'Pontos de atenção', sev: 'aviso', title: 'O SQL pode alterar ou apagar dados', meaning: 'O SQL tem comandos como INSERT, UPDATE, DELETE, DROP ou ALTER. Consultas da biblioteca costumam só ler dados.', hint: 'Confirme com quem criou a consulta se isso é intencional ANTES de publicar para o time.' },
    MULTIPLOS_COMANDOS: { g: 'Pontos de atenção', sev: 'aviso', title: 'O SQL tem mais de um comando', meaning: 'Há texto depois de um ponto e vírgula. Consultas dinâmicas costumam ter um comando só.', hint: 'Confira com quem criou a consulta se está certo.' },
    QUERY_GRANDE:       { g: 'Pontos de atenção', sev: 'aviso', title: 'O SQL é muito grande', meaning: 'O SQL tem mais de 200 mil caracteres. Funciona, mas é muito incomum.', hint: 'Confira se é o arquivo certo.' },

    /* ----- Repetidas ----- */
    DUP_LOTE:       { g: 'Repetidas', sev: 'aviso', title: 'Dois arquivos deste envio tinham o mesmo nome', meaning: 'Importei os dois, e o segundo ficou com outro nome para não sobrescrever o primeiro.', hint: 'Confira se são mesmo consultas diferentes. Se forem a mesma, exclua uma.' },
    MESMO_SQL:      { g: 'Repetidas', sev: 'aviso', title: 'O SQL é igual ao de outra consulta', meaning: 'Esta consulta usa exatamente o mesmo SQL de outra (do mesmo envio ou já cadastrada). Pode ser uma cópia.', hint: 'Se for cópia, considere manter só uma delas.' },
    NOME_REPETIDO:  { g: 'Repetidas', sev: 'aviso', title: 'Há outra consulta com o mesmo nome', meaning: 'As duas têm SQL diferente, mas o mesmo nome. Isso confunde o time na hora de buscar.', hint: 'Renomeie uma delas (botão Editar) para ficar fácil de distinguir.' },
    ATUALIZADA:     { g: 'Repetidas', sev: 'info', title: 'Atualizei uma consulta que já existia', meaning: 'Já havia uma consulta com o mesmo nome de arquivo. Atualizei o conteúdo e mantive as categorias, a descrição e os destaques que você já tinha definido.', hint: 'Nada a fazer. Se não era para atualizar, não publique e use Desfazer.' }
  };

  function mk(code, detail, extra) {
    var def = ISSUES[code] || { sev: 'erro', title: code, hint: '' };
    var it = { code: code, sev: def.sev, title: def.title, hint: def.hint, detail: detail || '' };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) it[k] = extra[k];
    return it;
  }

  function isError(it) { return it.sev === 'erro'; }

  function describe(v) {
    if (v === null) return 'vazio';
    if (Array.isArray(v)) return 'uma lista com ' + v.length + ' item(ns)';
    if (typeof v === 'object') return 'um bloco de dados';
    if (typeof v === 'string') return 'um texto';
    if (typeof v === 'number') return 'um número';
    if (typeof v === 'boolean') return 'um sim/não';
    return 'um valor desconhecido';
  }

  function listNames(arr, max) {
    var shown = arr.slice(0, max || 8).join(', ');
    return arr.length > (max || 8) ? shown + ' e mais ' + (arr.length - (max || 8)) : shown;
  }

  /* ----- Diagnóstico de JSON inválido ----- */
  function lineCol(text, pos) {
    var lines = text.slice(0, pos).split('\n');
    return { line: lines.length, col: lines[lines.length - 1].length + 1 };
  }

  function posFromLineCol(text, line, col) {
    var lines = text.split('\n'), p = 0;
    for (var i = 0; i < line - 1 && i < lines.length; i++) p += lines[i].length + 1;
    return p + col - 1;
  }

  function snippetAt(text, pos) {
    var a = Math.max(0, pos - 45), b = Math.min(text.length, pos + 45);
    var s = text.slice(a, pos) + '\u27E6' + (text.charAt(pos) || '\u220E') + '\u27E7' + text.slice(pos + 1, b);
    return (a > 0 ? '\u2026' : '') + s.replace(/\r?\n/g, '\u21B5') + (b < text.length ? '\u2026' : '');
  }

  function tryParse(t) { try { JSON.parse(t); return true; } catch (e) { return false; } }

  function stripJsonComments(t) {
    var out = '', inStr = false, esc = false, i = 0;
    while (i < t.length) {
      var c = t.charAt(i), d = t.charAt(i + 1);
      if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; i++; continue; }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === '/' && d === '/') { while (i < t.length && t.charAt(i) !== '\n') i++; continue; }
      if (c === '/' && d === '*') { var e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 2; continue; }
      out += c; i++;
    }
    return out;
  }

  function escapeControlInStrings(t) {
    var out = '', inStr = false, esc = false;
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i), code = t.charCodeAt(i);
      if (inStr) {
        if (esc) { out += c; esc = false; continue; }
        if (c === '\\') { out += c; esc = true; continue; }
        if (c === '"') { inStr = false; out += c; continue; }
        if (code < 32) { out += code === 10 ? '\\n' : code === 13 ? '\\r' : code === 9 ? '\\t' : ' '; continue; }
        out += c;
      } else { if (c === '"') inStr = true; out += c; }
    }
    return out;
  }

  var REPAIRS = {
    virgula:   function (t) { return t.replace(/,(\s*[}\]])/g, '$1'); },
    comentario: stripJsonComments,
    aspas:     function (t) { return t.replace(/'/g, '"'); },
    chave:     function (t) { return t.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'); },
    valor:     function (t) { return t.replace(/\b(NaN|undefined|-?Infinity)\b/g, 'null'); },
    quebra:    escapeControlInStrings,
    escape:    function (t) { return t.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\'); },
    multiplos: function (t) { return '[' + t.replace(/}\s*{/g, '},{') + ']'; }
  };

  function diagnoseJson(text, err) {
    var msg = String((err && err.message) || err);
    var body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    var trimmed = body.trim(), pos = null, m;
    if ((m = msg.match(/position (\d+)/))) pos = Number(m[1]);
    else if ((m = msg.match(/line (\d+) column (\d+)/))) pos = posFromLineCol(body, Number(m[1]), Number(m[2]));
    var lc = pos != null ? lineCol(body, pos) : null;
    var where = lc ? ' (linha ' + lc.line + ', coluna ' + lc.col + ')' : '';
    var base = { tech: msg, line: lc ? lc.line : null, col: lc ? lc.col : null, snippet: pos != null ? snippetAt(body, pos) : '' };
    var first = trimmed.charAt(0);

    function out(code, detail) { return mk(code, detail, base); }

    if (first === '<') return out('JSON_HTML', 'O arquivo começa como uma página da internet (começa com "<").');
    if (/^(select|with|insert|update|delete|call|exec|execute)\b/i.test(trimmed)) return out('JSON_SQL_PURO', 'O arquivo começa com "' + trimmed.split(/\s+/)[0].toUpperCase() + '" (um comando SQL), e não como o arquivo exportado da consulta.');
    if (first !== '{' && first !== '[') return out('JSON_TEXTO_LIVRE', 'O arquivo começa com "' + trimmed.slice(0, 20).replace(/\s+/g, ' ') + '", que parece texto comum.');
    if (/end of (json )?(input|data)|unexpected end|unexpected eof/i.test(msg) || (/unterminated string/i.test(msg) && pos != null && pos >= trimmed.length - 1) || (pos != null && pos >= trimmed.length)) {
      return out('JSON_TRUNCADO', 'O arquivo acaba de repente, depois de ' + trimmed.length + ' caracteres.');
    }
    if (tryParse(REPAIRS.comentario(body))) return out('JSON_COMENTARIO', 'Há comentários dentro do arquivo' + where + '.');
    if (tryParse(REPAIRS.virgula(body))) return out('JSON_VIRGULA', 'Há uma vírgula sobrando antes de um fechamento' + where + '.');
    if (tryParse(REPAIRS.multiplos(body))) return out('JSON_MULTIPLOS', 'O arquivo contém mais de uma consulta colada na outra' + where + '.');
    if (tryParse(REPAIRS.quebra(body))) return out('JSON_QUEBRA_LINHA', 'Há uma quebra de linha no meio de um texto' + where + '.');
    if (tryParse(REPAIRS.escape(body))) return out('JSON_ESCAPE', 'Há uma barra invertida (\\) onde não deveria' + where + '.');
    if (tryParse(REPAIRS.valor(body))) return out('JSON_VALOR_INVALIDO', 'O arquivo tem valores como "undefined" ou "NaN"' + where + '.');
    if (tryParse(REPAIRS.chave(body))) return out('JSON_CHAVE_SEM_ASPAS', 'Há um nome sem aspas' + where + '.');
    if (tryParse(REPAIRS.aspas(body))) return out('JSON_ASPAS', 'O arquivo usa aspas simples' + where + '.');
    var combined = REPAIRS.virgula(REPAIRS.chave(REPAIRS.aspas(REPAIRS.comentario(body))));
    if (tryParse(combined)) return out('JSON_FORMATO_JS', 'O arquivo parece ter sido escrito à mão' + where + '.');
    if (/control character|unterminated|newline/i.test(msg)) return out('JSON_QUEBRA_LINHA', 'Há um texto que não fecha ou um caractere de controle' + where + '.');
    if (/escape/i.test(msg)) return out('JSON_ESCAPE', 'Há um caractere especial escrito errado' + where + '.');
    return out('JSON_SINTAXE', 'Há um erro de escrita no arquivo' + where + '.');
  }

  /* ----- SQL: remove comentários e textos para analisar o que sobra ----- */
  function stripSql(sql, keepStrings) {
    var out = '', i = 0, n = sql.length;
    while (i < n) {
      var c = sql.charAt(i), d = sql.charAt(i + 1);
      if (c === '-' && d === '-') { while (i < n && sql.charAt(i) !== '\n') i++; out += ' '; continue; }
      if (c === '/' && d === '*') { var e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
      if (c === "'") {
        var start = i; i++;
        while (i < n) {
          if (sql.charAt(i) === '\\') { i += 2; continue; }
          if (sql.charAt(i) === "'" && sql.charAt(i + 1) === "'") { i += 2; continue; }
          if (sql.charAt(i) === "'") { i++; break; }
          i++;
        }
        out += keepStrings ? sql.slice(start, i) : "''";
        continue;
      }
      out += c; i++;
    }
    return out;
  }

  function paramsOf(sql) {
    var list = [], re = /(^|[^:]):([A-Za-z_][A-Za-z0-9_]*)/g, m;
    while ((m = re.exec(sql)) !== null) { if (list.indexOf(m[2]) === -1) list.push(m[2]); }
    return list;
  }

  function normalizeSql(sql) { return stripSql(String(sql || ''), true).replace(/\s+/g, ' ').trim().toLowerCase(); }
  function newId() { return 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function looksLikeConsulta(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x) && typeof x.query === 'string' && Array.isArray(x.field);
  }

  function findKey(obj, candidates) {
    var keys = Object.keys(obj), found = null;
    keys.forEach(function (k) {
      if (found) return;
      if (candidates.indexOf(k.toLowerCase()) !== -1 && candidates.indexOf(k) === -1) found = k;
      else if (candidates.indexOf(k.toLowerCase()) !== -1 && k !== candidates[0]) found = k;
    });
    return found;
  }

  /* ----- Monta a consulta e acumula os avisos ----- */
  function buildQuery(data, fileName, issues) {
    var fields = data.field, nonObj = [], noName = [], noTipo = [], badTipo = [], dups = [], seen = {}, cols = [], declared = {};

    fields.forEach(function (f, i) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) { nonObj.push(i + 1); return; }
      var nm = (typeof f.name === 'string' || typeof f.name === 'number') ? String(f.name).trim() : '';
      var hasTipo = f.tipo !== undefined && f.tipo !== null && f.tipo !== '';
      var tipo = Number(f.tipo);
      if (hasTipo && isNaN(tipo)) badTipo.push(nm || ('posição ' + (i + 1)));
      if (!hasTipo && nm && nm.charAt(0) !== ':') noTipo.push(nm);
      if (nm && (nm.charAt(0) === ':' || !(hasTipo && tipo === 1))) declared[nm.replace(/^:/, '').toLowerCase()] = true;
      if (hasTipo && tipo === 1) {
        if (!nm) { noName.push(i + 1); return; }
        if (seen[nm]) { if (dups.indexOf(nm) === -1) dups.push(nm); return; }
        seen[nm] = true;
        var title = (typeof f.title === 'string' || typeof f.title === 'number') ? f.title : '';
        cols.push({ name: nm, label: humanize(nm, title), type: String(f.typeField || 'text') });
      }
    });

    var sql = data.query, rawParams = paramsOf(sql), cleanParams = paramsOf(stripSql(sql));
    var filters = rawParams.map(function (p) {
      var f = fields.filter(function (x) {
        return x && typeof x === 'object' && String(x.name || '').replace(/^:/, '').toLowerCase() === p.toLowerCase();
      })[0] || {};
      var title = (typeof f.title === 'string' || typeof f.title === 'number') ? f.title : '';
      return { name: ':' + p, label: humanize(p, title), type: String(f.typeField || 'date') };
    });

    // --- avisos
    if (fields.length === 0) issues.push(mk('FIELD_VAZIO', 'A consulta não tem nenhuma coluna nem filtro cadastrado.'));
    else if (cols.length === 0) issues.push(mk('SEM_COLUNAS', 'Existem ' + fields.length + ' campo(s), mas nenhum é uma coluna de resultado.'));
    if (nonObj.length) issues.push(mk('FIELD_ITEM_INVALIDO', nonObj.length + ' item(ns) da lista de colunas e filtros estavam em branco ou quebrados e foram ignorados (posições: ' + listNames(nonObj) + ').'));
    if (noName.length) issues.push(mk('CAMPO_SEM_NOME', noName.length + ' coluna(s) estão sem nome e foram ignoradas (posições: ' + listNames(noName) + ').'));
    if (noTipo.length) issues.push(mk('CAMPO_SEM_TIPO', noTipo.length + ' campo(s) não dizem se são colunas ou filtros: ' + listNames(noTipo) + '.'));
    if (badTipo.length) issues.push(mk('CAMPO_TIPO_INVALIDO', 'Campo(s) com uma indicação que não reconheço: ' + listNames(badTipo) + '.'));
    if (dups.length) issues.push(mk('COLUNA_DUPLICADA', 'Estas colunas aparecem mais de uma vez (mantive só a primeira de cada): ' + listNames(dups) + '.'));
    if (cols.length > WARN_COLUMNS) issues.push(mk('MUITAS_COLUNAS', 'A consulta retorna ' + cols.length + ' colunas.'));

    var semCampo = rawParams.filter(function (p) { return !declared[p.toLowerCase()]; });
    if (semCampo.length) issues.push(mk('PARAM_SEM_CAMPO', 'O SQL usa estes filtros, mas eles não estão descritos na consulta: ' + semCampo.map(function (p) { return ':' + p; }).join(', ') + '. Vou tratá-los como filtro de data.'));

    var emTexto = rawParams.filter(function (p) { return cleanParams.indexOf(p) === -1; });
    if (emTexto.length) issues.push(mk('PARAM_EM_TEXTO', 'Estes itens só aparecem dentro de um texto ou comentário do SQL, e podem não ser filtros de verdade: ' + emTexto.map(function (p) { return ':' + p; }).join(', ') + '.'));

    var naoUsados = fields.filter(function (f) {
      return f && typeof f === 'object' && typeof f.name === 'string' && f.name.charAt(0) === ':' && rawParams.map(function (p) { return p.toLowerCase(); }).indexOf(f.name.slice(1).toLowerCase()) === -1;
    }).map(function (f) { return f.name; });
    if (naoUsados.length) issues.push(mk('PARAM_NAO_USADO', 'Estes filtros estão cadastrados, mas o SQL não os usa: ' + listNames(naoUsados) + '.'));

    var clean = stripSql(sql);
    if (!/\b(select|with|insert|update|delete|call|exec|execute|show|values|table|merge|explain|create|drop|alter|truncate)\b/i.test(clean)) {
      issues.push(mk('QUERY_SEM_COMANDO', 'Não encontrei nenhum comando SQL conhecido (como SELECT) no texto da consulta.'));
    }
    var writes = clean.match(/\b(insert|update|delete|drop|truncate|alter|merge|create|grant|revoke)\b/gi);
    if (writes) {
      var uniq = []; writes.forEach(function (w) { w = w.toUpperCase(); if (uniq.indexOf(w) === -1) uniq.push(w); });
      issues.push(mk('COMANDO_ESCRITA', 'O SQL contém ' + uniq.join(', ') + ', comandos que podem alterar ou apagar dados.'));
    }
    if (/;\s*\S/.test(clean.trim())) issues.push(mk('MULTIPLOS_COMANDOS', 'O SQL tem mais de um comando (há texto depois de um ponto e vírgula).'));
    if (sql.length > WARN_QUERY_CHARS) issues.push(mk('QUERY_GRANDE', 'O SQL tem ' + sql.length + ' caracteres (mais de 200 mil).'));

    var name;
    if (typeof data.name === 'string' && data.name.trim()) name = data.name.trim();
    else {
      name = fileName.replace(/\.json$/i, '');
      if (data.name === undefined || data.name === null || data.name === '') issues.push(mk('NOME_AUSENTE', 'O arquivo não informa o nome da consulta. Usei o nome do arquivo: "' + name + '".'));
      else issues.push(mk('NOME_TIPO', 'O nome da consulta veio como ' + describe(data.name) + '. Usei o nome do arquivo: "' + name + '".'));
    }
    if (name.length < 3) issues.push(mk('NOME_CURTO', 'O nome "' + name + '" tem só ' + name.length + ' letra(s).'));
    if (name.length > 160) issues.push(mk('NOME_LONGO', 'O nome tem ' + name.length + ' caracteres (o ideal é até 160).'));

    return {
      id: newId(),
      name: name,
      categories: guessCategories(name),
      description: '',
      source_filename: fileName,
      columns: cols,
      primary_columns: cols.slice(0, 3).map(function (c) { return c.name; }),
      required_filters: filters,
      created_at: Date.now(),
      raw_json: data
    };
  }

  /* ----- Valida o conteúdo já convertido de JSON ----- */
  function analyzeData(data, fileName) {
    var issues = [];
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      issues.push(mk('RAIZ_TIPO', 'O conteúdo do arquivo é ' + describe(data) + ', e não uma consulta completa.'));
      return { q: null, issues: issues };
    }
    var hasQ = data.query !== undefined, hasF = data.field !== undefined;

    if (!hasQ && !hasF) {
      var inner = Object.keys(data).filter(function (k) { return looksLikeConsulta(data[k]); })[0];
      if (inner) {
        issues.push(mk('RAIZ_ENCAPSULADA', 'A consulta está guardada dentro de uma seção chamada "' + inner + '", e não no começo do arquivo.'));
        return { q: null, issues: issues };
      }
    }

    if (!hasQ) {
      var altQ = findKey(data, ['query', 'sql', 'consulta', 'script', 'statement', 'querytext', 'query_text']);
      issues.push(mk('QUERY_AUSENTE', 'O arquivo não tem o SQL da consulta.' + (Object.keys(data).length ? ' O que o arquivo contém: ' + listNames(Object.keys(data), 10) + '.' : ' O arquivo está vazio por dentro.'),
        altQ ? { hint: 'Encontrei "' + altQ + '" no arquivo, que pode ser o SQL, mas com outro nome. Confira se este é mesmo o arquivo exportado da consulta dinâmica.' } : null));
    } else if (typeof data.query !== 'string') {
      issues.push(mk('QUERY_TIPO', 'O SQL deveria ser um texto, mas veio como ' + describe(data.query) + '.'));
    } else if (!data.query.trim()) {
      issues.push(mk('QUERY_VAZIA', 'O espaço do SQL existe, mas está em branco.'));
    }

    if (!hasF) {
      var altF = findKey(data, ['field', 'fields', 'campos', 'columns', 'colunas']);
      issues.push(mk('FIELD_AUSENTE', 'O arquivo não tem a lista de colunas e filtros.',
        altF ? { hint: 'Encontrei "' + altF + '" no arquivo, que pode ser a lista de colunas, mas com outro nome. Confira se este é mesmo o arquivo exportado da consulta dinâmica.' } : null));
    } else if (!Array.isArray(data.field)) {
      issues.push(mk('FIELD_TIPO', 'A lista de colunas e filtros deveria ser uma lista, mas veio como ' + describe(data.field) + '.'));
    }

    if (issues.some(isError)) return { q: null, issues: issues };
    return { q: buildQuery(data, fileName, issues), issues: issues };
  }

  function normalizeLibraryItem(item, i) {
    var label = 'Item ' + (i + 1) + ': ';
    if (!item || typeof item !== 'object' || !item.raw_json || typeof item.raw_json !== 'object') {
      return { q: null, issues: [mk('BIBLIOTECA_ITEM', label + 'está sem o conteúdo da consulta.')] };
    }
    var fname = typeof item.source_filename === 'string' && item.source_filename ? item.source_filename : 'item_' + (i + 1) + '.json';
    var res = analyzeData(item.raw_json, fname);
    if (!res.q) { res.issues.forEach(function (x) { x.detail = label + x.detail; }); return res; }
    var q = res.q;
    if (item.id) q.id = String(item.id);
    if (typeof item.name === 'string' && item.name.trim()) q.name = item.name.trim();
    if (Array.isArray(item.categories) && item.categories.length) q.categories = item.categories.slice(0, 3).map(String);
    if (typeof item.description === 'string') q.description = item.description;
    if (item.created_at) q.created_at = item.created_at;
    if (Array.isArray(item.columns)) {
      var labels = {}; item.columns.forEach(function (c) { if (c && c.name && c.label) labels[c.name] = c.label; });
      q.columns.forEach(function (c) { if (labels[c.name]) c.label = labels[c.name]; });
    }
    if (Array.isArray(item.primary_columns)) {
      var names = q.columns.map(function (c) { return c.name; });
      var keep = item.primary_columns.filter(function (n) { return names.indexOf(n) !== -1; });
      if (keep.length) q.primary_columns = keep.slice(0, 4);
    }
    res.issues.forEach(function (x) { x.detail = label + x.detail; });
    return res;
  }

  /* ----- Entrada principal: texto de um arquivo .json ----- */
  // Retorna { results: [{ q, keep, issues }], issues: [problemas do arquivo, sem consulta] }
  function inspectText(text, fileName) {
    var pre = [];
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (!text.trim()) return { results: [], issues: [mk('ARQ_VAZIO', 'O arquivo não tem nenhum conteúdo.')] };
    if (text.length > MAX_FILE_CHARS) return { results: [], issues: [mk('ARQ_GRANDE', 'O arquivo tem ' + (text.length / 1048576).toFixed(1) + ' MB e o limite é 8 MB.')] };
    if (text.indexOf('\uFFFD') !== -1) pre.push(mk('ARQ_ENCODING', 'O texto tem o caractere � no lugar de alguns acentos.'));
    if (text.length > WARN_FILE_CHARS) pre.push(mk('ARQ_PESADO', 'O arquivo tem ' + (text.length / 1048576).toFixed(1) + ' MB.'));

    var data;
    try { data = JSON.parse(text); } catch (err) { return { results: [], issues: pre.concat([diagnoseJson(text, err)]) }; }

    if (Array.isArray(data)) {
      var isLib = data.length > 0 && data.some(function (x) { return x && typeof x === 'object' && x.raw_json && typeof x.raw_json === 'object'; });
      var anyQ = data.length > 0 && data.some(looksLikeConsulta);
      var results = [], issues = pre.slice();
      if (isLib) {
        data.forEach(function (item, i) {
          var r = normalizeLibraryItem(item, i);
          if (r.q) results.push({ q: r.q, keep: true, issues: r.issues }); else issues = issues.concat(r.issues);
        });
        return { results: results, issues: issues };
      }
      if (anyQ) {
        var stem = fileName.replace(/\.json$/i, '');
        data.forEach(function (item, i) {
          var r = analyzeData(item, stem + '_' + (i + 1) + '.json');
          r.issues.forEach(function (x) { x.detail = 'Item ' + (i + 1) + ': ' + x.detail; });
          if (r.q) results.push({ q: r.q, keep: false, issues: r.issues }); else issues = issues.concat(r.issues);
        });
        issues.push(mk('LISTA_EXPANDIDA', 'O arquivo tinha ' + data.length + ' consultas juntas; cada uma virou uma consulta separada.'));
        return { results: results, issues: issues };
      }
      var sample = data.length ? 'O primeiro item é ' + describe(data[0]) + '.' : 'A lista está vazia.';
      return { results: [], issues: pre.concat([mk('RAIZ_LISTA', 'O arquivo é uma lista de ' + data.length + ' item(ns). ' + sample)]) };
    }

    var res = analyzeData(data, fileName);
    if (!res.q) return { results: [], issues: pre.concat(res.issues) };
    return { results: [{ q: res.q, keep: false, issues: pre.concat(res.issues) }], issues: [] };
  }

  /* ---------- Importação ---------- */
  function setStatus(text) { $('importStatus').textContent = text; }

  function normalizeText(t) { return normalize(t).replace(/\s+/g, ' ').trim(); }

  var IGNORE_FILES = ['.ds_store', 'thumbs.db', 'desktop.ini'];

  function classifyName(path) {
    var base = path.split('/').pop(), low = base.toLowerCase();
    if (path.indexOf('__MACOSX/') !== -1 || low.indexOf('._') === 0 || IGNORE_FILES.indexOf(low) !== -1 || low.indexOf('~$') === 0) return 'sistema';
    if (/\.json$/i.test(base)) return 'json';
    if (/\.zip$/i.test(base)) return 'zip';
    return 'outro';
  }

  function stamp(it, path) { it.path = path; it.file = String(path).split('/').pop(); return it; }
  function fileItem(path, code, detail, extra) { return stamp(mk(code, detail, extra), path); }

  function extOf(name) { return name.indexOf('.') > 0 ? '.' + name.split('.').pop() : 'sem extensão'; }

  // Lê os arquivos enviados e monta a lista de entradas .json a analisar (abre os ZIPs)
  function collectEntries(inputs, items) {
    var entries = [], chain = Promise.resolve();
    inputs.forEach(function (file) {
      chain = chain.then(function () {
        var kind = classifyName(file.name);
        if (kind === 'sistema') { items.push(fileItem(file.name, 'ARQ_SISTEMA', 'Arquivo criado pelo sistema operacional.')); return; }
        if (kind === 'outro') { items.push(fileItem(file.name, 'ARQ_IGNORADO', 'O formato "' + extOf(file.name) + '" não é lido.')); return; }
        if (kind === 'json') { entries.push({ path: file.name, size: file.size, read: function () { return file.text(); } }); return; }

        return QH.ensureJSZip().then(function (JSZip) { return JSZip.loadAsync(file); }).then(function (zip) {
          var count = 0;
          Object.keys(zip.files).forEach(function (p) {
            if (zip.files[p].dir) return;
            var k = classifyName(p);
            if (k === 'sistema') items.push(fileItem(p, 'ARQ_SISTEMA', 'Arquivo criado pelo sistema operacional (dentro de ' + file.name + ').'));
            else if (k === 'outro') items.push(fileItem(p, 'ARQ_IGNORADO', 'O formato "' + extOf(p) + '" não é lido (dentro de ' + file.name + ').'));
            else if (k === 'zip') items.push(fileItem(p, 'ZIP_ANINHADO', 'ZIP dentro de ' + file.name + '.'));
            else { count++; entries.push({ path: p, size: null, read: function () { return zip.files[p].async('string'); } }); }
          });
          if (!count) items.push(fileItem(file.name, 'ZIP_SEM_JSON', 'O ZIP foi aberto, mas não tem nenhum arquivo .json.'));
        }).catch(function (err) {
          var msg = String((err && err.message) || err);
          var code = /encrypted/i.test(msg) ? 'ZIP_PROTEGIDO' : 'ZIP_INVALIDO';
          items.push(fileItem(file.name, code, code === 'ZIP_PROTEGIDO' ? 'O ZIP exige senha.' : 'O arquivo não pôde ser aberto como ZIP.', { tech: msg }));
        });
      });
    });
    return chain.then(function () { return entries; });
  }

  // Analisa cada entrada .json (uma por vez, cedendo a tela de vez em quando)
  function analyzeEntries(entries, items, onProgress) {
    var results = [], chain = Promise.resolve();
    entries.forEach(function (en, idx) {
      chain = chain.then(function () {
        if (onProgress && idx % 25 === 0) {
          onProgress(idx, entries.length);
          return new Promise(function (resolve) { setTimeout(resolve, 0); });
        }
      }).then(function () {
        if (en.size != null && en.size > MAX_FILE_CHARS * 1.5) {
          items.push(fileItem(en.path, 'ARQ_GRANDE', 'O arquivo tem ' + (en.size / 1048576).toFixed(1) + ' MB e o limite é 8 MB.'));
          return;
        }
        return en.read().then(function (text) {
          var res = inspectText(text, en.path.split('/').pop());
          res.issues.forEach(function (it) { items.push(stamp(it, en.path)); });
          res.results.forEach(function (r) { r.path = en.path; results.push(r); });
        }, function (err) {
          items.push(fileItem(en.path, 'ARQ_LEITURA', 'Falha ao ler: ' + String((err && err.message) || err)));
        });
      });
    });
    return chain.then(function () { return results; });
  }

  // Duplicidades: mesmo nome de arquivo, mesmo SQL e mesmo nome (no envio e na biblioteca atual)
  function crossCheck(results) {
    var fileOwner = {}, dupCount = {}, sqlOwner = {}, nameOwner = {}, libSql = {}, libName = {};
    state.queries.forEach(function (q) {
      var s = normalizeSql(q.raw_json && q.raw_json.query), n = normalizeText(q.name);
      if (s && !libSql[s]) libSql[s] = q.source_filename;
      if (n && !libName[n]) libName[n] = q.source_filename;
    });

    results.forEach(function (r) {
      var q = r.q, base = q.source_filename;

      if (fileOwner[base] !== undefined) {
        var stem = base.replace(/\.json$/i, ''), n = (dupCount[base] || 1) + 1, nn;
        do { nn = stem + '_' + n + '.json'; n++; } while (fileOwner[nn] !== undefined);
        dupCount[base] = n - 1;
        r.issues.push(mk('DUP_LOTE', 'Outro arquivo deste mesmo envio também se chamava "' + base + '" (' + fileOwner[base] + '). Importei os dois: esta cópia ficou como "' + nn + '".'));
        q.source_filename = nn;
        base = nn;
      }
      fileOwner[base] = r.path;

      var sql = normalizeSql(q.raw_json.query), sameSql = null;
      if (sql) {
        if (sqlOwner[sql]) sameSql = sqlOwner[sql];
        else if (libSql[sql] && libSql[sql] !== base) sameSql = libSql[sql];
        if (!sqlOwner[sql]) sqlOwner[sql] = base;
      }
      if (sameSql) r.issues.push(mk('MESMO_SQL', 'O SQL é idêntico ao da consulta do arquivo "' + sameSql + '".'));

      var nm = normalizeText(q.name);
      if (nm && !sameSql) {
        var other = nameOwner[nm] || (libName[nm] && libName[nm] !== base ? libName[nm] : null);
        if (other) r.issues.push(mk('NOME_REPETIDO', 'Já existe outra consulta chamada "' + q.name + '" (arquivo "' + other + '"), mas com SQL diferente.'));
        if (!nameOwner[nm]) nameOwner[nm] = base;
      }
    });
  }

  function runImport(inputs, onProgress) {
    var items = [];
    return collectEntries(inputs, items).then(function (entries) {
      return analyzeEntries(entries, items, onProgress).then(function (results) {
        crossCheck(results);
        return { results: results, items: items, entriesCount: entries.length };
      });
    });
  }

  /* ---------- Relatório de importação ----------
     É uma lista de pendências que acompanha o que você faz: ao excluir uma consulta, salvar a edição
     dela ou marcar como revisada, o item deixa de aparecer. Erros de arquivos que não entraram ficam
     até serem corrigidos (reenviando o arquivo) ou dispensados. */
  var REPORT_KEY = 'queryhub:last-report:v2';
  var OLD_REPORT_KEY = 'queryhub:last-report:v1';
  var SEV_LABEL = { erro: 'Erro', aviso: 'Aviso', info: 'Info', ignorado: 'Ignorado' };
  var uidCounter = 0;

  function uid() { return 'i' + Date.now().toString(36) + (++uidCounter).toString(36) + Math.random().toString(36).slice(2, 5); }

  function buildReport(an, source, counts) {
    var items = an.items.slice(), withWarn = 0;
    an.results.forEach(function (r) {
      var warns = r.issues.filter(function (i) { return i.sev !== 'erro'; });
      if (warns.some(function (i) { return i.sev === 'aviso'; })) withWarn++;
      var id = r.finalId || r.q.id;
      warns.forEach(function (w) {
        var it = stamp(Object.assign({}, w), r.path);
        it.queryId = id;
        it.queryName = r.q.name;
        items.push(it);
      });
    });
    items.forEach(function (it) {
      if (!it.rid) it.rid = uid();
      if (it.code === 'LISTA_EXPANDIDA') {            // aviso do arquivo: vale enquanto alguma consulta dele existir
        it.queryIds = an.results.filter(function (r) { return r.path === it.path; }).map(function (r) { return r.finalId || r.q.id; });
      }
    });
    var errorFiles = {};
    items.forEach(function (i) { if (i.sev === 'erro') errorFiles[i.path] = true; });
    return {
      id: 'r_' + Date.now().toString(36),
      createdAt: Date.now(),
      source: source,
      items: items,
      totals: {
        lidos: an.entriesCount,
        importadas: an.results.length,
        atualizadas: counts.updated,
        comAviso: withWarn,
        comErro: Object.keys(errorFiles).length,
        ignorados: items.filter(function (i) { return i.sev === 'ignorado'; }).length
      }
    };
  }

  // Só o que ainda precisa de atenção: some o que foi dispensado e o que pertence a consultas excluídas
  function activeItems() {
    var r = state.report;
    if (!r) return [];
    var ids = {};
    state.queries.forEach(function (q) { ids[q.id] = true; });
    return r.items.filter(function (i) {
      if (i.dismissed) return false;
      if (i.queryId && !ids[i.queryId]) return false;
      if (i.queryIds && !i.queryIds.some(function (id) { return ids[id]; })) return false;
      return true;
    });
  }

  function pendingCounts() {
    var act = activeItems(), errFiles = {}, warnQ = {}, ignored = 0;
    act.forEach(function (i) {
      if (i.sev === 'erro') errFiles[i.path] = true;
      else if (i.sev === 'aviso') warnQ[i.queryId || i.path] = true;
      else if (i.sev === 'ignorado') ignored++;
    });
    return { erros: Object.keys(errFiles).length, avisos: Object.keys(warnQ).length, ignorados: ignored, items: act };
  }

  // Junta o envio novo com o que ainda estava pendente de envios anteriores
  function registerReport(an, source, counts) {
    var fresh = buildReport(an, source, counts);
    var prev = state.report ? state.report.items : [];
    var ids = {}, touched = {};
    state.queries.forEach(function (q) { ids[q.id] = true; });
    fresh.items.forEach(function (i) { touched[i.path] = true; });
    an.results.forEach(function (r) { touched[r.path] = true; });      // arquivo reenviado e aceito resolve o erro antigo
    var carried = prev.filter(function (i) {
      return !i.dismissed && (i.sev === 'erro' || i.sev === 'aviso') && !touched[i.path] && (!i.queryId || ids[i.queryId]);
    });
    fresh.items = carried.concat(fresh.items);
    state.report = fresh;
    saveReport();
    invalidateWarn();
    updateReportButton();
    return fresh;
  }

  function saveReport() {
    var r = state.report;
    if (!r) { try { localStorage.removeItem(REPORT_KEY); } catch (err) { /* ignora */ } return; }
    try {
      var slim = {
        id: r.id, createdAt: r.createdAt, source: r.source, totals: r.totals,
        items: r.items.slice(0, 3000).map(function (i) {
          return { rid: i.rid, code: i.code, sev: i.sev, title: i.title, hint: i.hint, detail: String(i.detail || '').slice(0, 400), tech: String(i.tech || '').slice(0, 200), snippet: String(i.snippet || '').slice(0, 200), line: i.line, col: i.col, path: i.path, file: i.file, queryId: i.queryId, queryIds: i.queryIds, queryName: i.queryName, dismissed: i.dismissed ? 1 : undefined };
        })
      };
      localStorage.setItem(REPORT_KEY, JSON.stringify(slim));
      localStorage.removeItem(OLD_REPORT_KEY);
    } catch (err) { /* sem espaço: o relatório fica só na memória */ }
  }

  function loadReport() {
    try { state.report = JSON.parse(localStorage.getItem(REPORT_KEY) || localStorage.getItem(OLD_REPORT_KEY) || 'null'); } catch (err) { state.report = null; }
    if (state.report) state.report.items.forEach(function (it) { if (!it.rid) it.rid = uid(); });
    updateReportButton();
  }

  // O botão só aparece enquanto houver erro ou aviso pendente
  function updateReportButton() {
    var btn = $('btnReport');
    if (!btn) return;
    var c = pendingCounts(), total = c.erros + c.avisos;
    btn.classList.toggle('hidden', !total);
    var badge = $('reportBadge');
    badge.textContent = total ? String(total) : '';
    badge.classList.toggle('hidden', !total);
    badge.classList.toggle('count-badge--warn', !c.erros);
    btn.title = c.erros || c.avisos ? (c.erros ? c.erros + ' arquivo(s) com erro e ' : '') + c.avisos + ' consulta(s) para conferir' : '';
  }

  function warningsFor(q) {
    var out = [], r = state.report;
    if (r) r.items.forEach(function (i) { if (i.queryId === q.id && !i.dismissed && (i.sev === 'aviso' || i.sev === 'info')) out.push(i); });
    (state.warnById[q.id] || []).forEach(function (w) { out.push(w); });
    return out;
  }

  function reportTabOf(it) { return it.sev === 'info' || it.sev === 'aviso' ? 'aviso' : it.sev; }

  function describeSource(files) { return files.length === 1 ? files[0].name : files.length + ' arquivos'; }

  function formatDate(ts) {
    var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var reportGroups = {};

  function openReport(tab) {
    if (!state.report) return;
    var c = pendingCounts();
    state.reportTab = tab || (c.erros ? 'erro' : (c.avisos ? 'aviso' : (state.reportTab || 'erro')));
    $('reportSearch').value = '';
    renderReport();
    openModal($('reportModal'));
  }

  var TAB_INTRO = {
    erro: 'Estes arquivos NÃO entraram na biblioteca. Veja "O que fazer", corrija o arquivo e envie de novo. Se for um arquivo que não importa, clique em "Dispensar".',
    aviso: 'Estas consultas JÁ entraram, mas vale uma conferida. Abra cada uma, ajuste o que precisar e clique em "Já revisei". Ao salvar a consulta no editor, o aviso some sozinho.',
    ignorado: 'Estes arquivos não são consultas e foram pulados. Não precisa fazer nada.'
  };

  function rowHtml(it) {
    var cat = ISSUES[it.code] || {};
    var h = '<div class="irow"><div class="irow__top"><code>' + esc(it.path || it.file || '') + '</code><span class="irow__actions">';
    if (it.queryId && findQuery(it.queryId)) h += '<button type="button" class="link-btn" data-open-query="' + esc(it.queryId) + '">Abrir consulta</button>';
    if (it.sev === 'aviso' || it.sev === 'info') h += '<button type="button" class="link-btn" data-dismiss="' + esc(it.rid) + '">Já revisei</button>';
    else if (it.sev === 'erro') h += '<button type="button" class="link-btn" data-dismiss="' + esc(it.rid) + '">Dispensar</button>';
    h += '</span></div><div class="irow__detail">' + esc(it.detail) + '</div>';
    if (it.snippet) {
      h += '<div class="irow__where">' + (it.line ? 'Linha ' + it.line + ', coluna ' + it.col + '. ' : '') + 'O ponto exato do problema está entre ⟦ ⟧:</div><pre class="snippet">' + esc(it.snippet) + '</pre>';
    }
    if (it.hint && it.hint !== cat.hint) h += '<div class="irow__hint"><b>O que fazer:</b> ' + esc(it.hint) + '</div>';
    if (it.tech) h += '<details class="irow__tech"><summary>Detalhe técnico</summary>' + esc(it.tech) + '</details>';
    return h + '</div>';
  }

  function fillGroup(det) {
    var code = det.getAttribute('data-code'), list = reportGroups[code] || [];
    var body = det.querySelector('.igroup__body'), shown = Number(det.getAttribute('data-shown') || 0), step = 100;
    var more = body.querySelector('[data-more]');
    if (more) more.remove();
    body.insertAdjacentHTML('beforeend', list.slice(shown, shown + step).map(rowHtml).join(''));
    shown = Math.min(list.length, shown + step);
    det.setAttribute('data-shown', String(shown));
    if (shown < list.length) {
      body.insertAdjacentHTML('beforeend', '<button type="button" class="btn btn--sm" data-more="' + esc(code) + '">Mostrar mais (' + (list.length - shown) + ' restantes)</button>');
    }
  }

  function renderReport() {
    var r = state.report;
    if (!r) return;
    var tab = state.reportTab || 'erro', c = pendingCounts(), t = r.totals || {};
    $('reportSub').textContent = 'Último envio: ' + r.source + ' · ' + formatDate(r.createdAt) + ' · ' + (t.lidos || 0) + ' arquivo(s) lido(s), ' + (t.importadas || 0) + ' importada(s)';

    $('reportSummary').innerHTML = [
      ['Arquivos com erro', c.erros, c.erros ? 'err' : 'ok'], ['Consultas para conferir', c.avisos, c.avisos ? 'warn' : 'ok'], ['Arquivos pulados', c.ignorados, '']
    ].map(function (x) { return '<div class="rsum rsum--' + x[2] + '"><b>' + x[1] + '</b><span>' + x[0] + '</span></div>'; }).join('');

    var counts = { erro: 0, aviso: 0, ignorado: 0 };
    c.items.forEach(function (i) { counts[reportTabOf(i)]++; });
    document.querySelectorAll('.rtab').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-rtab') === tab);
      b.querySelector('em').textContent = counts[b.getAttribute('data-rtab')];
    });
    $('reportIntro').textContent = TAB_INTRO[tab];

    var term = normalize($('reportSearch').value), groups = {}, order = [];
    c.items.filter(function (i) {
      if (reportTabOf(i) !== tab) return false;
      return !term || normalize([i.path, i.detail, i.title, i.code].join(' ')).indexOf(term) !== -1;
    }).forEach(function (i) {
      if (!groups[i.code]) { groups[i.code] = []; order.push(i.code); }
      groups[i.code].push(i);
    });
    order.sort(function (a, b) { return groups[b].length - groups[a].length; });
    reportGroups = groups;

    var box = $('reportList');
    var openCodes = {}, scrollTop = box.scrollTop, hadGroups = !!box.querySelector('details.igroup');
    box.querySelectorAll('details.igroup[open]').forEach(function (d) { openCodes[d.getAttribute('data-code')] = true; });
    if (!order.length) {
      var allDone = !c.erros && !c.avisos;
      box.innerHTML = allDone && tab !== 'ignorado'
        ? '<div class="rempty rok"><b>Tudo resolvido ✓</b><p>Não há erros nem consultas para conferir. Quando você excluir, corrigir ou revisar algo, a lista se atualiza sozinha.</p></div>'
        : '<p class="muted-text rempty">' + (term ? 'Nada encontrado para essa busca.' : tab === 'erro' ? 'Nenhum erro pendente.' : tab === 'aviso' ? 'Nenhuma consulta para conferir.' : 'Nenhum arquivo pulado.') + '</p>';
      return;
    }
    box.innerHTML = order.map(function (code) {
      var d = ISSUES[code] || { title: code, meaning: '', hint: '', sev: 'erro' };
      var bulkLabel = d.sev === 'erro' ? 'Dispensar todos' : 'Marcar todos como revisados';
      return '<details class="igroup" data-code="' + esc(code) + '" data-shown="0"><summary>' +
        '<span class="sev sev--' + d.sev + '">' + SEV_LABEL[d.sev] + '</span><strong>' + esc(d.title) + '</strong><em>' + groups[code].length + '</em></summary>' +
        '<div class="igroup__body"><p class="igroup__meaning"><b>O que significa:</b> ' + esc(d.meaning) + '</p>' +
        '<p class="igroup__hint"><b>O que fazer:</b> ' + esc(d.hint) + '</p>' +
        (d.sev === 'ignorado' ? '' : '<div class="igroup__actions"><button type="button" class="link-btn" data-dismiss-group="' + esc(code) + '">' + bulkLabel + ' (' + groups[code].length + ')</button></div>') +
        '</div></details>';
    }).join('');

    box.querySelectorAll('details.igroup').forEach(function (det) {
      det.addEventListener('toggle', function () { if (det.open && !Number(det.getAttribute('data-shown'))) fillGroup(det); });
    });
    var reopened = false;
    box.querySelectorAll('details.igroup').forEach(function (det) {
      if (openCodes[det.getAttribute('data-code')]) { det.open = true; reopened = true; }
    });
    var firstGroup = box.querySelector('details.igroup');
    if (!reopened && !hadGroups && firstGroup && (order.length <= 3 || term)) firstGroup.open = true;
    box.scrollTop = scrollTop;
  }

  /* ----- Dispensar / marcar como revisado ----- */
  function afterReportChange() {
    saveReport();
    invalidateWarn();
    if ($('reportModal').open) renderReport();
    updateReportButton();
    renderReview();
    if (state.review === 'warn') QH.renderList();
  }

  function dismissItem(rid) {
    var r = state.report;
    if (!r) return;
    r.items.forEach(function (i) { if (i.rid === rid) i.dismissed = true; });
    afterReportChange();
  }

  function dismissGroup(code) {
    var tab = state.reportTab || 'erro';
    activeItems().forEach(function (i) { if (i.code === code && reportTabOf(i) === tab) i.dismissed = true; });
    afterReportChange();
  }

  function resolveFileErrors(path) {
    var r = state.report, any = false;
    if (!r) return;
    r.items.forEach(function (i) { if (i.path === path && i.sev === 'erro' && !i.dismissed) { i.dismissed = true; any = true; } });
    if (any) afterReportChange();
  }

  function dismissQuery(id) {
    var r = state.report, any = false;
    if (!r) return;
    r.items.forEach(function (i) { if (i.queryId === id && !i.dismissed) { i.dismissed = true; any = true; } });
    delete state.warnById[id];
    if (any) afterReportChange();
  }

  function clearReport() {
    var n = pendingCounts();
    if (!n.erros && !n.avisos && !n.ignorados) { toast('Não há nada pendente.'); return; }
    if (!window.confirm('Limpar a lista de pendências? As consultas continuam na biblioteca; só os avisos e erros deste relatório deixam de aparecer.')) return;
    activeItems().forEach(function (i) { i.dismissed = true; });
    afterReportChange();
    toast('Lista de pendências limpa.');
  }

  function csvEscape(v) {
    v = String(v == null ? '' : v);
    return /[";\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function reportCsv() {
    if (!state.report) return;
    var lines = [['arquivo', 'caminho', 'tipo', 'codigo', 'o_que_aconteceu', 'detalhe', 'o_que_fazer', 'linha', 'coluna', 'trecho'].join(';')];
    activeItems().forEach(function (i) {
      lines.push([i.file, i.path, SEV_LABEL[i.sev] || i.sev, i.code, i.title, i.detail, i.hint, i.line || '', i.col || '', i.snippet || ''].map(csvEscape).join(';'));
    });
    download('pendencias_importacao.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function reportCopy() {
    var r = state.report;
    if (!r) return;
    var c = pendingCounts(), lines = ['Pendências da importação – ' + r.source + ' (' + formatDate(r.createdAt) + ')',
      c.erros + ' arquivo(s) com erro · ' + c.avisos + ' consulta(s) para conferir', ''];
    c.items.filter(function (i) { return i.sev === 'erro'; }).forEach(function (i) {
      lines.push('• ' + i.path + ' – ' + i.title + '. ' + i.detail + ' O que fazer: ' + i.hint);
    });
    if (!navigator.clipboard) { toast('Seu navegador não permite copiar automaticamente.'); return; }
    navigator.clipboard.writeText(lines.join('\n')).then(function () { toast('Resumo dos erros copiado.'); });
  }

  function renderGuide() {
    var groups = {}, order = [];
    Object.keys(ISSUES).forEach(function (code) {
      var d = ISSUES[code];
      if (!groups[d.g]) { groups[d.g] = []; order.push(d.g); }
      groups[d.g].push(code);
    });
    $('guideBody').innerHTML = order.map(function (g) {
      return '<h3 class="guide__group">' + esc(g) + '</h3><div class="guide__wrap"><table class="guide"><thead><tr><th>Tipo</th><th>Mensagem</th><th>O que significa</th><th>O que fazer</th></tr></thead><tbody>' +
        groups[g].map(function (code) {
          var d = ISSUES[code];
          return '<tr><td><span class="sev sev--' + d.sev + '">' + SEV_LABEL[d.sev] + '</span></td><td><b>' + esc(d.title) + '</b><br><code>' + esc(code) + '</code></td><td>' + esc(d.meaning) + '</td><td>' + esc(d.hint) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }).join('');
  }

  function openGuide() {
    if (!$('guideBody').innerHTML) renderGuide();
    openModal($('guideModal'));
  }

  /* ---------- Fluxos de envio ---------- */
  function summaryText(t) {
    var parts = [t.importadas + ' importada(s)'];
    if (t.atualizadas) parts.push(t.atualizadas + ' atualizada(s)');
    if (t.comAviso) parts.push(t.comAviso + ' com aviso');
    parts.push(t.comErro + ' com erro');
    if (t.ignorados) parts.push(t.ignorados + ' ignorado(s)');
    return parts.join(' · ');
  }

  function finishBatch(an, source) {
    if (!an.results.length && !an.items.length) { setStatus('Nenhum arquivo para importar.'); return; }
    var counts = { added: 0, updated: 0 };
    if (an.results.length) { counts = applyImport(an); changed(); }
    var t = registerReport(an, source, counts).totals;
    var text = summaryText(t);
    setStatus(text + '.');
    toast(text + '.');
    if (t.comErro || t.comAviso) {
      closeModal($('importModal'));
      openReport(t.comErro ? 'erro' : 'aviso');
    }
  }

  function afterSingle(an, files) {
    var errs = an.items.filter(isError);
    if (!an.results.length) {
      var lines = errs.slice(0, 3).map(function (e) {
        return e.title + '\nO que aconteceu: ' + e.detail + (e.snippet ? '\nTrecho: ' + e.snippet : '') + '\nO que fazer: ' + e.hint;
      });
      if (!lines.length) lines = an.items.slice(0, 3).map(function (e) { return e.title + ': ' + e.detail; });
      setStatus(lines.join('\n\n') + (lines.length ? '\n\n(Você também encontra isto no botão "Relatório", no topo da página.)' : ''));
      registerReport(an, describeSource(files), { added: 0, updated: 0 });
      return;
    }
    if (an.results.length === 1 && !an.results[0].keep && !errs.length) {
      var r = an.results[0];
      resolveFileErrors(r.path);        // o arquivo agora está bom: some o erro antigo dele
      state.warnById[r.q.id] = r.issues.filter(function (i) { return i.sev !== 'erro'; });
      setStatus('');
      closeModal($('importModal'));
      openEditor(r.q, true);
      return;
    }
    finishBatch(an, describeSource(files));
  }

  function progress(done, total) { setStatus('Analisando ' + done + ' de ' + total + ' arquivos...'); }

  function failImport(err) { setStatus('Erro inesperado ao analisar os arquivos: ' + String((err && err.message) || err)); }

  function handleBatch(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    setStatus('Lendo arquivos...');
    runImport(files, progress).then(function (an) {
      $('batchFile').value = '';
      if (files.length === 1 && classifyName(files[0].name) === 'json') afterSingle(an, files);
      else finishBatch(an, describeSource(files));
    }).catch(failImport);
  }

  function handleSingleFile(file) {
    if (!file) return;
    setStatus('Lendo arquivo...');
    runImport([file], progress).then(function (an) {
      $('singleFile').value = '';
      afterSingle(an, [file]);
    }).catch(failImport);
  }

  function handlePaste() {
    var text = $('pasteJson').value;
    if (!text.trim()) { setStatus('Cole o conteúdo do JSON da consulta.'); return; }
    var name = 'consulta_colada.json';
    try { var d = JSON.parse(text); if (d && typeof d.name === 'string' && d.name.trim()) name = slug(d.name) + '.json'; } catch (err) { /* o diagnóstico vem da análise */ }
    var file = new File([text], name, { type: 'application/json' });
    setStatus('Analisando...');
    runImport([file], progress).then(function (an) {
      if (an.results.length) $('pasteJson').value = '';
      afterSingle(an, [file]);
    }).catch(failImport);
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


  /* ==========================================================================
     Rascunho, base publicada e diferenças
     ========================================================================== */
  var DRAFT_KEY = 'queryhub:admin-draft:v3';
  var OLD_DRAFT_KEY = 'queryhub:admin-draft:v2';
  var MAX_CATEGORIES = QH.MAX_CATEGORIES;
  var MAX_HIGHLIGHTS = QH.MAX_HIGHLIGHTS;

  var baseline = null;      // { sigs: { id: [meta, json, num] }, names: { id: nome } } = o que está publicado
  var legacyDirty = false;  // rascunho antigo, sem base para comparar
  var draftWarned = false;

  function hash(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  var rawHashes = new WeakMap();
  function rawHash(q) {
    var raw = q.raw_json;
    if (!raw || typeof raw !== 'object') return '';
    var h = rawHashes.get(raw);
    if (!h) { h = hash(JSON.stringify(raw)); rawHashes.set(raw, h); }
    return h;
  }

  function sigOf(q) {
    var labels = (q.columns || []).map(function (c) { return c.label; }).join('|');
    var meta = hash(JSON.stringify([q.name, q.categories, q.description, q.primary_columns, labels, q.source_filename]));
    return [meta, rawHash(q), q.num || ''];
  }

  function makeBaseline(list) {
    var b = { sigs: {}, names: {} };
    list.forEach(function (q) { b.sigs[q.id] = sigOf(q); b.names[q.id] = q.name; });
    return b;
  }

  function computeDiff() {
    if (!baseline) return { unknown: true, added: [], changed: [], removed: [], total: legacyDirty ? 1 : 0 };
    var cur = {}, added = [], changed = [], removed = [];
    state.queries.forEach(function (q) {
      cur[q.id] = true;
      var b = baseline.sigs[q.id];
      if (!b) { added.push(q); return; }
      var s = sigOf(q), why = [];
      if (b[1] !== s[1]) why.push('JSON atualizado');
      if (b[0] !== s[0]) why.push('dados editados');
      if (String(b[2]) !== String(s[2])) why.push('ID');
      if (why.length) changed.push({ q: q, why: why });
    });
    Object.keys(baseline.sigs).forEach(function (id) {
      if (!cur[id]) removed.push({ id: id, name: baseline.names[id] || id });
    });
    return { unknown: false, added: added, changed: changed, removed: removed, total: added.length + changed.length + removed.length };
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (raw) return JSON.parse(raw);
      var old = localStorage.getItem(OLD_DRAFT_KEY);
      if (old) { var d = JSON.parse(old); if (d) { d.baseline = null; d.legacyDirty = !!d.dirty; } return d; }
    } catch (err) { /* rascunho ilegível: começa do zero */ }
    return null;
  }

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ queries: state.queries, baseline: baseline }));
      localStorage.removeItem(OLD_DRAFT_KEY);
    } catch (err) {
      if (!draftWarned) { draftWarned = true; toast('O rascunho é grande demais para o navegador. Publique logo para não perder as alterações.'); }
    }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem(OLD_DRAFT_KEY); } catch (err) { /* ignora */ }
  }

  // Depois de qualquer alteração na biblioteca
  function changed() {
    saveDraft();
    QH.dataChanged();
  }

  /* ==========================================================================
     Desfazer
     ========================================================================== */
  var undoStack = [];

  function pushUndo(label, fn) {
    undoStack.push({ label: label, fn: fn });
    if (undoStack.length > 25) undoStack.shift();
  }

  function undo() {
    var e = undoStack.pop();
    if (!e) { toast('Não há nada para desfazer.'); return; }
    e.fn();
    saveDraft();
    QH.dataChanged();
    toast('Desfeito: ' + e.label + '.');
  }

  function withUndoToast(message, label) {
    toast(message, { action: 'Desfazer', onAction: undo, ms: 9000 });
  }

  /* ==========================================================================
     IDs e junção de consultas
     ========================================================================== */
  function maxNum() {
    var m = 0;
    state.queries.forEach(function (q) { if (q.num > m) m = q.num; });
    return m;
  }

  // Consultas antigas (sem ID) recebem números em ordem de cadastro
  function assignMissingNums() {
    var missing = state.queries.filter(function (q) { return !q.num; }).sort(function (a, b) {
      return (a.created_at || 0) - (b.created_at || 0) || String(a.name).localeCompare(String(b.name), 'pt-BR');
    });
    var n = maxNum();
    missing.forEach(function (q) { q.num = ++n; QH.invalidate(q); });
    return missing.length;
  }

  function findIndex(item) {
    var idx = -1;
    state.queries.forEach(function (q, i) {
      if (q.id === item.id || (item.source_filename && q.source_filename === item.source_filename)) idx = i;
    });
    return idx;
  }

  // Une consultas à biblioteca: arquivos com o mesmo nome atualizam a consulta existente
  function mergeLibrary(list, keepData) {
    var added = [], replaced = [], used = {};
    state.queries.forEach(function (q) { if (q.num) used[q.num] = true; });
    var next = maxNum();

    list.forEach(function (item) {
      var idx = findIndex(item);
      item.updated_at = Date.now();
      if (idx >= 0) {
        var old = state.queries[idx];
        if (!keepData) {
          // Reenvio do mesmo arquivo: atualiza o JSON e mantém o que já foi cadastrado
          var labels = {};
          (old.columns || []).forEach(function (c) { labels[c.name] = c.label; });
          item.columns.forEach(function (c) { if (labels[c.name]) c.label = labels[c.name]; });
          var names = item.columns.map(function (c) { return c.name; });
          var keep = (old.primary_columns || []).filter(function (n) { return names.indexOf(n) !== -1; });
          item.id = old.id;
          item.categories = old.categories;
          item.description = old.description;
          item.created_at = old.created_at;
          if (keep.length) item.primary_columns = keep;
        }
        item.num = old.num;
        state.queries[idx] = item;
        replaced.push({ old: old, now: item });
      } else {
        if (!item.num || used[item.num]) item.num = ++next;
        else { used[item.num] = true; if (item.num > next) next = item.num; }
        state.queries.unshift(item);
        added.push(item);
      }
    });
    return { added: added.length, updated: replaced.length, changes: { added: added, replaced: replaced } };
  }

  function undoChanges(ch) {
    var addedSet = new Set(ch.added);
    state.queries = state.queries.filter(function (q) { return !addedSet.has(q); });
    ch.replaced.forEach(function (r) {
      var i = state.queries.indexOf(r.now);
      if (i >= 0) { state.queries[i] = r.old; QH.invalidate(r.old); }
    });
    ch.added.forEach(function (q) { delete state.selected[q.id]; });
  }

  // Grava as consultas válidas na biblioteca
  function applyImport(an) {
    var existing = {};
    state.queries.forEach(function (q) { existing[q.source_filename] = true; });
    var normal = an.results.filter(function (r) { return !r.keep; });
    var kept = an.results.filter(function (r) { return r.keep; });
    var updatedResults = an.results.filter(function (r) { return existing[r.q.source_filename]; });

    var a = mergeLibrary(normal.map(function (r) { return r.q; }), false);
    var b = mergeLibrary(kept.map(function (r) { return r.q; }), true);
    var ch = { added: a.changes.added.concat(b.changes.added), replaced: a.changes.replaced.concat(b.changes.replaced) };
    pushUndo('importação de ' + an.results.length + ' consulta(s)', function () { undoChanges(ch); });

    var idByFile = {};
    state.queries.forEach(function (q) { idByFile[q.source_filename] = q.id; });
    an.results.forEach(function (r) { r.finalId = idByFile[r.q.source_filename] || r.q.id; });
    updatedResults.forEach(function (r) {
      r.issues.push(mk('ATUALIZADA', 'Já existia uma consulta do arquivo "' + r.q.source_filename + '". Atualizei o conteúdo e mantive categorias, descrição e destaques.'));
    });
    return { added: a.added + b.added, updated: a.updated + b.updated };
  }

  /* ==========================================================================
     Revisão da biblioteca (fila de pendências)
     ========================================================================== */
  function hasDesc(q) { return !!(q.description && String(q.description).trim()); }
  function onlyOthers(q) { var c = q.categories || []; return !c.length || (c.length === 1 && c[0] === 'Outros'); }
  function isPending(q) { return !hasDesc(q) || onlyOthers(q); }

  var warnCache = null;
  function invalidateWarn() { warnCache = null; }
  function warnSet() {
    if (warnCache) return warnCache;
    var set = {};
    activeItems().forEach(function (i) { if (i.sev === 'aviso' && i.queryId) set[i.queryId] = true; });
    warnCache = set;
    return set;
  }

  QH.reviewMatch = function (q, mode) {
    if (mode === 'pending') return isPending(q);
    if (mode === 'nodesc') return !hasDesc(q);
    if (mode === 'others') return onlyOthers(q);
    if (mode === 'warn') return !!warnSet()[q.id];
    return true;
  };

  var REVIEW_LABELS = { pending: 'Pendentes', nodesc: 'Sem descrição', others: 'Só em "Outros"', warn: 'Com aviso' };
  QH.reviewLabel = function (mode) { return REVIEW_LABELS[mode] || mode; };

  function setReview(mode) {
    state.review = mode;
    QH.renderChips();
    QH.renderList();
    renderReview();
  }

  function renderReview() {
    var qs = state.queries, total = qs.length, nodesc = 0, others = 0, pending = 0, warn = 0, ws = warnSet();
    qs.forEach(function (q) {
      var nd = !hasDesc(q), o = onlyOthers(q);
      if (nd) nodesc++;
      if (o) others++;
      if (nd || o) pending++;
      if (ws[q.id]) warn++;
    });
    var ready = total - pending;
    $('reviewPanel').classList.toggle('hidden', !total);
    $('reviewCount').textContent = pending ? ready + ' de ' + total + ' prontas' : 'Tudo revisado ✓';
    $('reviewFill').style.width = (total ? Math.round(ready / total * 100) : 0) + '%';
    var btn = $('reviewPending');
    btn.classList.toggle('hidden', !pending);
    btn.textContent = state.review === 'pending' ? 'Ver todas' : 'Ver pendentes (' + pending + ')';
    var items = [['', 'Todas', total], ['pending', 'Pendentes', pending], ['nodesc', 'Sem descrição', nodesc], ['others', 'Só em "Outros"', others], ['warn', 'Com aviso', warn]];
    $('reviewOptions').innerHTML = items.map(function (it) {
      return '<button type="button" class="chip' + (state.review === it[0] ? ' is-active' : '') + '" data-review="' + it[0] + '">' + esc(it[1]) + ' <span class="chip__count">' + it[2] + '</span></button>';
    }).join('');
  }

  /* ==========================================================================
     Barra de publicação, menu e itens de estado
     ========================================================================== */
  function renderPubBar() {
    var d = computeDiff(), n = d.total, bar = $('pubBar');
    bar.classList.toggle('is-visible', n > 0);
    $('pubBarText').textContent = d.unknown ? 'Há alterações não publicadas' : (n === 1 ? '1 alteração não publicada' : n + ' alterações não publicadas');
    $('pubBarUndo').disabled = !undoStack.length;
    $('btnUndo').disabled = !undoStack.length;
    requestAnimationFrame(function () {
      document.documentElement.style.setProperty('--bottom-offset', n > 0 ? (bar.offsetHeight + 'px') : '0px');
    });
    QH.lastDiff = d;
  }

  QH.afterRender = function () {
    invalidateWarn();
    renderReview();
    renderPubBar();
    updateReportButton();
  };

  function bindMenu() {
    var menu = $('moreMenu'), btn = $('btnMore');
    function setOpen(o) { menu.classList.toggle('is-open', o); btn.setAttribute('aria-expanded', String(o)); }
    btn.addEventListener('click', function (e) { e.stopPropagation(); setOpen(!menu.classList.contains('is-open')); });
    document.addEventListener('click', function (e) { if (!menu.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
    menu.addEventListener('click', function (e) { if (e.target.closest('.menu__item')) setOpen(false); });
  }

  /* ==========================================================================
     Publicação (com resumo do que muda)
     ========================================================================== */
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

  function setPublishing(flag) {
    state.publishing = flag;
    $('btnPublish').disabled = flag;
    $('btnPublish').textContent = flag ? 'Publicando…' : 'Revisar e publicar';
    $('pubConfirm').disabled = flag;
  }

  function ensureBaseline() {
    if (baseline) return Promise.resolve();
    return QH.fetchLibrary().then(function (list) { baseline = makeBaseline(list); saveDraft(); }).catch(function () { /* sem base: o resumo mostra só o total */ });
  }

  function openPublishSummary(force) {
    if (state.publishing) return;
    ensureBaseline().then(function () {
      var d = computeDiff(), total = state.queries.length;
      if (!d.total && !force) { toast('Não há alterações para publicar. Para enviar tudo de novo, use "Republicar tudo" no menu ⋯.'); return; }
      var warn = $('pubWarn'), warnText = '';
      if (!total) warnText = 'ATENÇÃO: a biblioteca está VAZIA. Publicar vai apagar TODAS as consultas do site do time.';
      else if (baseline && d.removed.length >= 10 && d.removed.length / Math.max(1, Object.keys(baseline.sigs).length) >= 0.3) {
        warnText = 'Você está removendo ' + d.removed.length + ' de ' + Object.keys(baseline.sigs).length + ' consultas publicadas. Confira a lista abaixo.';
      }
      warn.classList.toggle('hidden', !warnText);
      warn.textContent = warnText;
      var onlyIds = !d.unknown && !d.added.length && !d.removed.length && d.changed.length && d.changed.every(function (c) { return c.why.length === 1 && c.why[0] === 'ID'; });
      $('pubSub').textContent = onlyIds ? 'Esta publicação só atribui um número (ID) às consultas que já existiam. Nada mais muda para o time.' : 'Confira o que vai mudar. O site atualiza em cerca de 1 minuto.';

      if (!d.total) {
        $('pubSummary').innerHTML = '<div class="pubsum__box"><b>' + total + '</b><span>consultas serão reenviadas</span></div>';
        $('pubList').innerHTML = '<div class="pubdiff__row">Nenhuma alteração pendente. A biblioteca inteira será enviada de novo, com os IDs. Use isto se o time não estiver vendo os números.</div>';
        $('pubSub').textContent = 'Reenvio completo da biblioteca.';
      } else if (d.unknown) {
        $('pubSummary').innerHTML = '<div class="pubsum__box"><b>' + total + '</b><span>consultas na biblioteca</span></div>';
        $('pubList').innerHTML = '<div class="pubdiff__row">Não foi possível comparar com a versão publicada. A biblioteca inteira será enviada.</div>';
      } else {
        $('pubSummary').innerHTML =
          '<div class="pubsum__box pubsum__box--add"><b>' + d.added.length + '</b><span>novas</span></div>' +
          '<div class="pubsum__box pubsum__box--chg"><b>' + d.changed.length + '</b><span>alteradas</span></div>' +
          '<div class="pubsum__box pubsum__box--del"><b>' + d.removed.length + '</b><span>removidas</span></div>';
        var rows = [];
        d.added.forEach(function (q) { rows.push(['info', 'Nova', q.name, q.num]); });
        d.changed.forEach(function (c) { rows.push(['aviso', 'Alterada', c.q.name + ' – ' + c.why.join(', '), c.q.num]); });
        d.removed.forEach(function (r) { rows.push(['erro', 'Removida', r.name]); });
        var shown = rows.slice(0, 60);
        $('pubList').innerHTML = shown.map(function (r) {
          return '<div class="pubdiff__row"><span class="sev sev--' + r[0] + '">' + r[1] + '</span><span>' + (r[3] ? '<span class="qid">' + QH.formatId(r[3]) + '</span> ' : '') + esc(r[2]) + '</span></div>';
        }).join('') + (rows.length > shown.length ? '<div class="pubdiff__row">… e mais ' + (rows.length - shown.length) + ' item(ns).</div>' : '');
      }
      $('pubTotal').textContent = total + (total === 1 ? ' consulta será publicada' : ' consultas serão publicadas');
      openModal($('publishModal'));
    });
  }

  function doPublish() {
    if (state.publishing) return;
    if (!window.CompressionStream) { toast('Seu navegador é antigo para publicar. Atualize o Chrome, Edge ou Safari.'); return; }
    var empty = state.queries.length === 0;
    setPublishing(true);

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
      baseline = makeBaseline(state.queries);
      saveDraft();
      closeModal($('publishModal'));
      QH.dataChanged();
      var localNums = state.queries.filter(function (q) { return q.num; }).length;
      if (result.data.nums !== localNums) {
        toast('Publicado, mas o servidor não gravou os IDs. Atualize o arquivo api/admin/publish.js no GitHub e use "Republicar tudo" no menu ⋯.', { ms: 14000 });
      } else {
        toast('Publicado! O time verá as mudanças em cerca de 1 minuto, quando o deploy terminar.');
      }
    }).catch(function (err) {
      toast(err.message);
    }).then(function () { setPublishing(false); });
  }

  function discardDraft() {
    if (!window.confirm('Descartar o rascunho e recarregar a biblioteca publicada? As alterações não publicadas serão perdidas.')) return;
    clearDraft();
    undoStack = [];
    state.selected = {};
    QH.closeDrawer();
    QH.fetchLibrary().then(function (list) {
      state.queries = list;
      baseline = makeBaseline(list);
      legacyDirty = false;
      assignMissingNums();
      saveDraft();
      QH.dataChanged();
      toast('Biblioteca recarregada.');
    }).catch(function (err) { toast(err.message); });
  }

  /* ==========================================================================
     Edição de uma consulta
     ========================================================================== */
  function categoryPickerHtml(selected) {
    return QH.CATEGORIES.map(function (cat) {
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

  function snapshot(q) {
    var labels = {};
    (q.columns || []).forEach(function (c) { labels[c.name] = c.label; });
    return { name: q.name, categories: (q.categories || []).slice(), description: q.description, primary_columns: (q.primary_columns || []).slice(), labels: labels, updated_at: q.updated_at };
  }

  function restore(q, s) {
    q.name = s.name; q.categories = s.categories; q.description = s.description; q.primary_columns = s.primary_columns; q.updated_at = s.updated_at;
    (q.columns || []).forEach(function (c) { if (s.labels[c.name] !== undefined) c.label = s.labels[c.name]; });
    QH.invalidate(q);
  }

  function queuePosition(q) {
    var list = QH.visibleQueries(), i = list.indexOf(q);
    return i === -1 ? '' : ' · ' + (state.review ? 'fila: ' : 'posição: ') + (i + 1) + ' de ' + list.length;
  }

  function openEditor(q, isNew) {
    state.editing = { query: q, isNew: !!isNew };

    $('editTitle').textContent = isNew ? 'Nova consulta' : 'Editar consulta';
    $('editSummary').textContent = (q.num ? QH.formatId(q.num) + ' · ' : '') + (q.source_filename || '') + ' · ' +
      (q.columns || []).length + ' colunas · ' + (q.required_filters || []).length + ' filtros' + (isNew ? '' : queuePosition(q));
    $('editName').value = q.name;
    $('editDesc').value = q.description || '';
    $('editDelete').classList.toggle('hidden', !!isNew);
    $('editSaveNext').classList.toggle('hidden', !!isNew);

    var warns = warningsFor(q), wbox = $('editWarnings');
    wbox.classList.toggle('hidden', !warns.length);
    wbox.innerHTML = warns.length
      ? '<strong>Pontos de atenção desta consulta (' + warns.length + ')</strong><ul>' + warns.map(function (w) {
          return '<li><b>' + esc(w.title) + '.</b> ' + esc(w.detail) + (w.hint ? ' <em>' + esc(w.hint) + '</em>' : '') + '</li>';
        }).join('') + '</ul>'
      : '';

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
    openModal($('editModal'));
    $('editModal').scrollTop = 0;
  }

  function saveEditor(goNext) {
    var ctx = state.editing;
    if (!ctx) return;
    var q = ctx.query;

    var name = $('editName').value.trim();
    if (name.length < 3) { toast('Informe o nome da consulta.'); $('editName').focus(); return; }
    var cols = checkedValues('colPicker');
    if (!cols.length && (q.columns || []).length) { toast('Marque ao menos uma coluna em destaque.'); return; }

    var order = QH.visibleQueries(), pos = order.indexOf(q);
    var before = ctx.isNew ? null : snapshot(q);

    var cats = checkedValues('catPicker');
    q.name = name;
    q.categories = cats.length ? cats : ['Outros'];
    q.description = $('editDesc').value.trim();
    q.primary_columns = cols;
    $('colPicker').querySelectorAll('[data-label-for]').forEach(function (input) {
      var col = (q.columns || []).filter(function (c) { return c.name === input.getAttribute('data-label-for'); })[0];
      if (col && input.value.trim()) col.label = input.value.trim();
    });
    q.updated_at = Date.now();
    QH.invalidate(q);

    if (ctx.isNew) {
      var r = mergeLibrary([q], true);
      pushUndo('cadastro de "' + q.name + '"', function () { undoChanges(r.changes); });
      toast(r.updated ? 'Consulta existente atualizada.' : 'Consulta cadastrada com o ID ' + QH.formatId(q.num) + '.');
    } else {
      pushUndo('edição de "' + q.name + '"', function () { restore(q, before); });
      toast('Consulta salva.');
    }

    changed();
    dismissQuery(q.id);                    // quem revisa e salva resolve os avisos desta consulta
    if (state.openId === q.id) QH.openDrawer(q.id);

    if (goNext && !ctx.isNew) {
      var next = order[pos + 1];
      if (next) { openEditor(next, false); return; }
      toast('Você chegou ao fim da lista. 🎉');
    }
    closeModal($('editModal'));
  }

  function removeQueries(list) {
    var removed = [];
    state.queries.forEach(function (q, i) { if (list.indexOf(q) !== -1) removed.push({ q: q, index: i }); });
    state.queries = state.queries.filter(function (q) { return list.indexOf(q) === -1; });
    list.forEach(function (q) { delete state.selected[q.id]; });
    return removed;
  }

  function restoreRemoved(removed) {
    removed.forEach(function (r) { state.queries.splice(Math.min(r.index, state.queries.length), 0, r.q); QH.invalidate(r.q); });
  }

  function deleteEditing() {
    var ctx = state.editing;
    if (!ctx || ctx.isNew) return;
    var q = ctx.query;
    if (!window.confirm('Excluir a consulta "' + q.name + '"?')) return;
    var removed = removeQueries([q]);
    pushUndo('exclusão de "' + q.name + '"', function () { restoreRemoved(removed); });
    QH.closeDrawer();
    changed();
    closeModal($('editModal'));
    withUndoToast('Consulta excluída.');
  }

  /* ---------- Ações em lote ---------- */
  function openBulkCategories() {
    var n = QH.selectedIds().length;
    $('bulkModalSub').textContent = 'As categorias escolhidas substituem as atuais em ' + n + (n === 1 ? ' consulta.' : ' consultas.');
    $('bulkPicker').innerHTML = categoryPickerHtml([]);
    limitChecks('bulkPicker', MAX_CATEGORIES, 'bulkPickerCount');
    openModal($('bulkModal'));
  }

  function applyBulkCategories() {
    var cats = checkedValues('bulkPicker');
    if (!cats.length) { toast('Escolha ao menos uma categoria.'); return; }
    var before = [];
    QH.selectedIds().forEach(function (id) {
      var q = findQuery(id);
      if (!q) return;
      before.push({ q: q, cats: (q.categories || []).slice(), updated: q.updated_at });
      q.categories = cats.slice();
      q.updated_at = Date.now();
      QH.invalidate(q);
    });
    pushUndo('categorias de ' + before.length + ' consulta(s)', function () {
      before.forEach(function (b) { b.q.categories = b.cats; b.q.updated_at = b.updated; QH.invalidate(b.q); });
    });
    changed();
    closeModal($('bulkModal'));
    withUndoToast('Categorias aplicadas a ' + before.length + ' consulta(s).');
  }

  function bulkDelete() {
    var list = QH.selectedIds().map(findQuery).filter(Boolean);
    if (!window.confirm('Excluir ' + list.length + ' consulta(s) selecionada(s)?')) return;
    var removed = removeQueries(list);
    pushUndo('exclusão de ' + list.length + ' consulta(s)', function () { restoreRemoved(removed); });
    changed();
    withUndoToast(list.length + ' consulta(s) excluída(s).');
  }

  /* ==========================================================================
     Arrastar arquivos para qualquer lugar da tela
     ========================================================================== */
  function bindDrop() {
    var overlay = $('dropOverlay'), depth = 0;
    function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') !== -1; }
    function show(v) { overlay.classList.toggle('is-visible', v); overlay.setAttribute('aria-hidden', v ? 'false' : 'true'); }
    window.addEventListener('dragenter', function (e) { if (hasFiles(e)) { depth++; show(true); } });
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) show(false); });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      var handled = e.defaultPrevented;   // as áreas de soltar dos pop-ups já tratam o próprio envio
      e.preventDefault();
      depth = 0; show(false);
      if (handled) return;
      var files = Array.prototype.slice.call(e.dataTransfer.files || []);
      if (!files.length) return;
      if (!$('importModal').open) toast('Analisando ' + files.length + ' arquivo(s)...');
      handleBatch(files);
    });
  }

  /* ==========================================================================
     Ligações dos eventos do painel
     ========================================================================== */
  function bindAdmin() {
    bindMenu();
    bindDrop();

    on('btnImport', 'click', function () { switchTab('single'); setStatus(''); openModal($('importModal')); });
    on('btnPublish', 'click', function () { openPublishSummary(false); });
    on('btnPublishMenu', 'click', function () { openPublishSummary(false); });
    on('btnRepublish', 'click', function () { openPublishSummary(true); });
    on('pubConfirm', 'click', doPublish);
    on('pubBarUndo', 'click', undo);
    on('btnUndo', 'click', undo);
    on('btnDiscard', 'click', discardDraft);
    on('menuGuide', 'click', openGuide);
    on('menuSecurity', 'click', openSecurity);
    on('secReload', 'click', loadSecurity);
    on('menuLogs', 'click', openLogs);
    on('logReload', 'click', loadLogs);
    on('logFilter', 'input', function () { renderLogs(); });

    on('reviewOptions', 'click', function (e) {
      var b = e.target.closest('[data-review]');
      if (b) setReview(b.getAttribute('data-review'));
    });
    on('reviewPending', 'click', function () { setReview(state.review === 'pending' ? '' : 'pending'); });

    on('drawerEdit', 'click', function () {
      var q = findQuery(state.openId);
      if (q) openEditor(q, false);
    });

    // Relatório e guia
    on('btnReport', 'click', function () { openReport(); });
    on('importGuide', 'click', openGuide);
    on('reportGuide', 'click', openGuide);
    on('reportCsv', 'click', reportCsv);
    on('reportCopy', 'click', reportCopy);
    on('reportMore', 'click', function () { closeModal($('reportModal')); switchTab('batch'); openModal($('importModal')); });
    on('reportSearch', 'input', renderReport);
    document.querySelectorAll('.rtab').forEach(function (b) {
      b.addEventListener('click', function () { state.reportTab = b.getAttribute('data-rtab'); renderReport(); });
    });
    on('reportClear', 'click', clearReport);
    on('reportList', 'click', function (e) {
      var open = e.target.closest('[data-open-query]');
      if (open) {
        var q = findQuery(open.getAttribute('data-open-query'));
        if (q) { closeModal($('reportModal')); openEditor(q, false); }
        return;
      }
      var one = e.target.closest('[data-dismiss]');
      if (one) { dismissItem(one.getAttribute('data-dismiss')); return; }
      var grp = e.target.closest('[data-dismiss-group]');
      if (grp) { dismissGroup(grp.getAttribute('data-dismiss-group')); return; }
      var more = e.target.closest('[data-more]');
      if (more) { var det = more.closest('details'); if (det) fillGroup(det); }
    });

    // Cadastro
    document.querySelectorAll('.tabs__btn').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
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

    // Edição e lote
    on('catPicker', 'change', function () { limitChecks('catPicker', MAX_CATEGORIES, 'catCount'); });
    on('colPicker', 'change', function () { limitChecks('colPicker', MAX_HIGHLIGHTS, 'colCount', ' em destaque'); });
    on('editSave', 'click', function () { saveEditor(false); });
    on('editSaveNext', 'click', function () { saveEditor(true); });
    on('editDelete', 'click', deleteEditing);
    on('bulkCategories', 'click', openBulkCategories);
    on('bulkApply', 'click', applyBulkCategories);
    on('bulkPicker', 'change', function () { limitChecks('bulkPicker', MAX_CATEGORIES, 'bulkPickerCount'); });
    on('bulkDelete', 'click', bulkDelete);

    // Ctrl+Z / Cmd+Z desfaz a última ação
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
      var tag = document.activeElement ? document.activeElement.tagName : '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      undo();
    });

    // Avisa antes de sair com alterações não publicadas
    window.addEventListener('beforeunload', function (e) {
      if (computeDiff().total > 0) { e.preventDefault(); e.returnValue = ''; }
    });

    loadReport();
  }

  /* ==========================================================================
     Carregamento da biblioteca no painel (rascunho ou versão publicada)
     ========================================================================== */
  QH.loadLibrary = function () {
    var draft = loadDraft();
    if (draft && Array.isArray(draft.queries) && (draft.queries.length || draft.baseline || draft.legacyDirty)) {
      state.queries = draft.queries;
      baseline = draft.baseline || null;
      legacyDirty = !!draft.legacyDirty;
      var p = Promise.resolve();
      if (!baseline) {
        p = QH.fetchLibrary().then(function (list) { baseline = makeBaseline(list); legacyDirty = false; }).catch(function () { /* sem base */ });
      }
      return p.then(afterLoad);
    }
    return QH.fetchLibrary().then(function (list) {
      state.queries = list;
      baseline = makeBaseline(list);
    }).catch(function (err) {
      state.loadError = err.message;
      toast(err.message);
    }).then(afterLoad);
  };

  function afterLoad() {
    var n = assignMissingNums();
    if (n) {
      saveDraft();
      setTimeout(function () { toast('Atribuí IDs a ' + n + ' consulta(s). Publique para o time passar a ver os números.'); }, 600);
    }
  }

  /* ==========================================================================
     Segurança e acesso (todos do painel) + Logs de acesso (somente master)
     ========================================================================== */
  var ROLE_PT = { master: 'Master', admin: 'Admin', viewer: 'Consulta', blocked: 'Bloqueado' };

  // Mostra os itens de menu só de master quando o usuário for master
  function applyCaps(user) {
    var master = !!(user && user.canManageUsers);
    document.querySelectorAll('.js-master-only').forEach(function (el) { el.classList.toggle('hidden', !master); });
  }
  QH.hooks.user = applyCaps;

  function openSecurity() { openModal($('securityModal')); loadSecurity(); }

  function loadSecurity() {
    $('secError').textContent = '';
    var banner = $('secBanner');
    banner.className = 'sec-banner';
    banner.textContent = 'Carregando…';
    fetch('/api/admin/status', { cache: 'no-store' }).then(function (res) {
      if (res.status === 401) { window.location.replace('/login.html'); return null; }
      return res.json().then(function (d) { return { ok: res.ok, status: res.status, d: d }; });
    }).then(function (r) {
      if (!r) return;
      if (!r.ok) { banner.textContent = '—'; $('secError').textContent = 'Não foi possível carregar o status (' + (r.d.error || r.status) + ').'; return; }
      renderSecurity(r.d);
    }).catch(function () { banner.textContent = '—'; $('secError').textContent = 'Falha de conexão.'; });
  }

  function renderSecurity(d) {
    var listMode = d.mode === 'list';
    var banner = $('secBanner');
    banner.className = 'sec-banner ' + (listMode ? 'sec-banner--list' : 'sec-banner--domain');
    banner.innerHTML = listMode
      ? '🔒 <b>Somente pessoas da lista</b> entram. Nem contas @' + esc(d.domain) + ' fora da lista acessam.'
      : '🏢 <b>Somente contas @' + esc(d.domain) + '</b> entram (mais quem estiver liberado na lista). Qualquer outra conta Google é recusada no servidor.';

    var rows = [
      ['Domínio permitido', '@' + d.domain],
      ['Regra de entrada', listMode ? 'Somente lista' : 'Empresa (todo @' + d.domain + ')'],
      ['Origem das regras', d.source === 'github' ? 'GitHub (painel)' : (d.source === 'env' ? 'Variáveis da Vercel' : 'Indisponível')],
      ['Seu perfil', ROLE_PT[d.role] || d.role],
      ['Logs de acesso', d.accessLog ? 'Ativados' : 'Desativados'],
      ['Pessoas', d.counts.masters + ' master · ' + d.counts.admins + ' admin · ' + d.counts.viewers + ' consulta · ' + d.counts.blocked + ' bloqueado']
    ];
    if (d.forced) rows.push(['Observação', 'A variável ALLOWED_EMAILS (Vercel) está forçando o modo lista.']);
    $('secGrid').innerHTML = rows.map(function (x) {
      return '<div class="sec-cell"><span class="sec-k">' + esc(x[0]) + '</span><span class="sec-v">' + esc(x[1]) + '</span></div>';
    }).join('');

    function people(title, emails, tag) {
      if (!emails || !emails.length) return '';
      return '<div class="sec-pgroup"><h4>' + esc(title) + '</h4>' + emails.map(function (e) {
        return '<span class="sec-chip sec-chip--' + tag + '">' + esc(e) + '</span>';
      }).join('') + '</div>';
    }
    var peopleHtml = people('Masters fixos (Vercel, imutáveis)', d.owners, 'master') +
      people('Masters (definidos no painel)', d.masters, 'master') +
      people('Admins (sobem consulta)', d.admins, 'admin');
    $('secPeople').innerHTML = peopleHtml || '<p class="muted-text">Nenhum acesso elevado além dos masters fixos.</p>';

    var checks = [
      'Toda página e rota exige sessão válida (cookie assinado no servidor).',
      'O painel só abre para master ou admin — conferido a cada acesso.',
      'Usuários e logs: somente master.',
      listMode ? 'Entrada restrita às pessoas da lista.' : 'Entrada restrita a @' + d.domain + ' (domínio verificado pelo Google) e à lista.',
      'O perfil vem da lista no servidor, nunca do que o navegador informa.',
      'Contas de outros domínios são recusadas, exceto se liberadas como Consulta.'
    ];
    $('secChecks').innerHTML = checks.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('');
    $('secYou').textContent = 'Você: ' + d.you + ' · ' + (ROLE_PT[d.role] || d.role);
  }

  /* ---------- Logs (somente master) ---------- */
  var LOG_LABEL = { login_ok: 'Entrou', login_denied: 'Entrada NEGADA', publish_ok: 'Publicou', access_updated: 'Mudou acessos' };
  var logCache = [];

  function openLogs() { openModal($('logsModal')); loadLogs(); }

  function loadLogs() {
    $('logError').textContent = '';
    $('logList').innerHTML = '<p class="muted-text">Carregando…</p>';
    fetch('/api/admin/logs?limit=300', { cache: 'no-store' }).then(function (res) {
      if (res.status === 401) { window.location.replace('/login.html'); return null; }
      return res.json().then(function (d) { return { ok: res.ok, status: res.status, d: d }; });
    }).then(function (r) {
      if (!r) return;
      if (!r.ok) {
        logCache = []; $('logList').innerHTML = ''; $('logCount').textContent = '';
        $('logError').textContent = r.d.error === 'github_not_configured'
          ? 'O GitHub ainda não está configurado, então não há logs para mostrar.'
          : (r.d.error === 'forbidden_master' ? 'Apenas master pode ver os logs.' : 'Não foi possível carregar os logs.');
        return;
      }
      logCache = Array.isArray(r.d.entries) ? r.d.entries : [];
      $('logNote').textContent = (r.d.branch ? 'Branch de logs: ' + r.d.branch + ' · ' : '') + 'até ' + (r.d.total || logCache.length) + ' evento(s) guardados.';
      renderLogs();
    }).catch(function () { $('logError').textContent = 'Falha de conexão.'; });
  }

  function renderLogs() {
    var term = normalize($('logFilter').value);
    var list = logCache.filter(function (e) {
      return !term || normalize((e.email || '') + ' ' + (e.event || '') + ' ' + (e.detail || '')).indexOf(term) !== -1;
    });
    $('logCount').textContent = list.length + ' evento(s)';
    if (!list.length) { $('logList').innerHTML = '<p class="muted-text">Nenhum evento.</p>'; return; }
    $('logList').innerHTML = list.map(function (e) {
      var when = '';
      try { when = e.ts ? new Date(e.ts).toLocaleString('pt-BR') : ''; } catch (err) { when = String(e.ts || ''); }
      var kind = e.event === 'login_denied' ? 'err' : (e.event === 'login_ok' ? 'ok' : 'info');
      return '<div class="log-row log-row--' + kind + '">' +
        '<span class="log-ev">' + esc(LOG_LABEL[e.event] || e.event || '') + '</span>' +
        '<span class="log-email">' + esc(e.email || '—') + (e.role ? ' <small>(' + esc(e.role) + ')</small>' : '') + '</span>' +
        '<span class="log-detail">' + esc(e.detail || '') + (e.ip ? ' · ' + esc(e.ip) : '') + '</span>' +
        '<span class="log-when">' + esc(when) + '</span>' +
      '</div>';
    }).join('');
  }

  QH.hooks.bind = bindAdmin;

  // Para testes e depuração
  QH.admin = {
    inspectText: inspectText, runImport: runImport, applyImport: applyImport, buildReport: buildReport, ISSUES: ISSUES,
    computeDiff: computeDiff, undo: undo, makeBaseline: makeBaseline, getBaseline: function () { return baseline; },
    undoDepth: function () { return undoStack.length; }, isPending: isPending, pendingCounts: pendingCounts
  };

})();
