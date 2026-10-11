/* ==========================================================================
   QueryHub | Painel admin
   Cadastro, validação de arquivos, relatório, edição, desfazer e publicação.
   Depende de js/app.js (window.QH).
   ========================================================================== */
(function () {
  'use strict';

  if (window.QHBuild) window.QHBuild.report('admin', '3.1.0');

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
    ARQ_VAZIO:    { g: 'Arquivo', sev: 'erro', title: 'Arquivo vazio', meaning: 'O arquivo não tem conteúdo (ou só tem espaços e quebras de linha).', hint: 'Exporte a consulta novamente na plataforma. O arquivo foi salvo sem dados.' },
    ARQ_GRANDE:   { g: 'Arquivo', sev: 'erro', title: 'Arquivo grande demais', meaning: 'O arquivo passa do limite de 8 MB.', hint: 'Uma consulta dinâmica normal tem poucos KB. Confira se não é o arquivo errado (backup, exportação de dados ou dump).' },
    ARQ_LEITURA:  { g: 'Arquivo', sev: 'erro', title: 'Não foi possível ler o arquivo', meaning: 'O navegador falhou ao abrir o arquivo.', hint: 'Selecione o arquivo de novo. Se estiver em pasta sincronizada (OneDrive, Google Drive), copie para o computador antes.' },
    ARQ_ENCODING: { g: 'Arquivo', sev: 'aviso', title: 'Caracteres corrompidos (codificação)', meaning: 'O texto tem o caractere � (acentos que se perderam na gravação do arquivo).', hint: 'Reexporte ou salve o arquivo como UTF-8. A consulta foi importada, mas nomes e comentários podem estar com acentos errados.' },
    ARQ_PESADO:   { g: 'Arquivo', sev: 'aviso', title: 'Arquivo pesado', meaning: 'O arquivo tem mais de 1 MB.', hint: 'Isso é incomum para uma consulta. A importação funcionou, mas confira se o conteúdo é o esperado.' },
    ARQ_IGNORADO: { g: 'Arquivo', sev: 'ignorado', title: 'Arquivo ignorado (não é .json)', meaning: 'Só arquivos .json e .zip são lidos.', hint: 'Nenhuma ação necessária, a menos que este arquivo devesse ser uma consulta. Nesse caso, exporte em .json.' },
    ARQ_SISTEMA:  { g: 'Arquivo', sev: 'ignorado', title: 'Arquivo de sistema ignorado', meaning: 'Arquivos como .DS_Store, Thumbs.db, desktop.ini e a pasta __MACOSX são criados pelo computador, não são consultas.', hint: 'Nenhuma ação necessária.' },

    /* ----- ZIP ----- */
    ZIP_INVALIDO:   { g: 'ZIP', sev: 'erro', title: 'ZIP inválido ou corrompido', meaning: 'O arquivo .zip não pôde ser aberto.', hint: 'O download pode ter sido interrompido. Baixe ou compacte de novo. Se possível, extraia o ZIP no computador e envie os .json.' },
    ZIP_PROTEGIDO:  { g: 'ZIP', sev: 'erro', title: 'ZIP protegido por senha', meaning: 'O .zip está criptografado e não pode ser lido pelo navegador.', hint: 'Extraia o ZIP com a senha e compacte de novo sem senha, ou envie os .json soltos.' },
    ZIP_SEM_JSON:   { g: 'ZIP', sev: 'erro', title: 'ZIP sem nenhum arquivo .json', meaning: 'O .zip abriu, mas não tem arquivos .json dentro.', hint: 'Confira se compactou o conteúdo certo. Os arquivos precisam terminar em .json.' },
    ZIP_ANINHADO:   { g: 'ZIP', sev: 'ignorado', title: 'ZIP dentro de ZIP ignorado', meaning: 'Há um .zip dentro do .zip. Os ZIPs internos não são abertos.', hint: 'Extraia o ZIP interno e envie os .json dele separadamente.' },

    /* ----- JSON (sintaxe) ----- */
    JSON_TRUNCADO:        { g: 'JSON', sev: 'erro', title: 'JSON cortado (arquivo incompleto)', meaning: 'O arquivo termina no meio do conteúdo.', hint: 'Provavelmente o download ou a cópia foi interrompido. Exporte a consulta de novo.' },
    JSON_VIRGULA:         { g: 'JSON', sev: 'erro', title: 'JSON com vírgula sobrando', meaning: 'Há uma vírgula antes de um } ou ] de fechamento.', hint: 'Remova a vírgula indicada. JSON não aceita vírgula depois do último item.' },
    JSON_ASPAS:           { g: 'JSON', sev: 'erro', title: 'JSON com aspas simples', meaning: 'O texto usa aspas simples (\') em vez de aspas duplas (").', hint: 'JSON exige aspas duplas em textos e nomes de campos. Reexporte da plataforma em vez de editar à mão.' },
    JSON_CHAVE_SEM_ASPAS: { g: 'JSON', sev: 'erro', title: 'JSON com nome de campo sem aspas', meaning: 'Algum nome de campo (como name ou query) está sem aspas.', hint: 'Em JSON, os nomes dos campos precisam estar entre aspas duplas.' },
    JSON_FORMATO_JS:      { g: 'JSON', sev: 'erro', title: 'Parece objeto JavaScript, não JSON', meaning: 'O conteúdo mistura aspas simples, campos sem aspas, comentários ou vírgulas sobrando.', hint: 'Esse formato é de código JavaScript. Reexporte a consulta da plataforma em JSON.' },
    JSON_COMENTARIO:      { g: 'JSON', sev: 'erro', title: 'JSON com comentários', meaning: 'O arquivo tem comentários (// ou /* */), que JSON não permite.', hint: 'Remova os comentários do arquivo.' },
    JSON_HTML:            { g: 'JSON', sev: 'erro', title: 'O arquivo é uma página HTML', meaning: 'O conteúdo começa com "<", típico de página da web.', hint: 'Provavelmente foi baixada uma página de erro ou de login no lugar do JSON. Entre na plataforma e exporte de novo.' },
    JSON_SQL_PURO:        { g: 'JSON', sev: 'erro', title: 'O arquivo contém SQL puro', meaning: 'O conteúdo começa com um comando SQL, não com { do JSON.', hint: 'Este arquivo parece só o texto do SQL. O QueryHub precisa do JSON exportado da consulta dinâmica, que traz também a lista de campos.' },
    JSON_TEXTO_LIVRE:     { g: 'JSON', sev: 'erro', title: 'O arquivo não parece JSON', meaning: 'O conteúdo não começa com { nem [ (parece texto comum).', hint: 'Confira se é o arquivo certo. O JSON da consulta começa com { .' },
    JSON_MULTIPLOS:       { g: 'JSON', sev: 'erro', title: 'Mais de um JSON no mesmo arquivo', meaning: 'Há vários objetos { } seguidos, sem estarem dentro de uma lista.', hint: 'Separe cada consulta em um arquivo próprio, ou coloque todas dentro de uma lista [ ... ].' },
    JSON_QUEBRA_LINHA:    { g: 'JSON', sev: 'erro', title: 'Quebra de linha dentro de um texto', meaning: 'Um texto entre aspas (normalmente o SQL) tem quebras de linha reais, que JSON não aceita.', hint: 'Dentro do JSON as quebras de linha precisam aparecer como \\n. Reexporte da plataforma.' },
    JSON_ESCAPE:          { g: 'JSON', sev: 'erro', title: 'Barra invertida sem escape', meaning: 'Há uma \\ dentro de um texto sem estar escrita como \\\\.', hint: 'Troque \\ por \\\\ dentro dos textos, ou reexporte o arquivo.' },
    JSON_VALOR_INVALIDO:  { g: 'JSON', sev: 'erro', title: 'Valor inválido (undefined, NaN ou Infinity)', meaning: 'JSON não aceita esses valores.', hint: 'Troque por null ou remova o campo.' },
    JSON_SINTAXE:         { g: 'JSON', sev: 'erro', title: 'JSON com erro de sintaxe', meaning: 'O arquivo não é um JSON válido e o erro não se encaixa nos casos comuns.', hint: 'Veja a linha e o trecho indicados. Valide o arquivo em um validador de JSON ou reexporte da plataforma.' },

    /* ----- Estrutura ----- */
    RAIZ_TIPO:        { g: 'Estrutura', sev: 'erro', title: 'Conteúdo no formato errado', meaning: 'O arquivo é um JSON válido, mas não é um objeto { } (é um número, texto, verdadeiro/falso ou nulo).', hint: 'O arquivo da consulta dinâmica é um objeto com name, query e field.' },
    RAIZ_LISTA:       { g: 'Estrutura', sev: 'erro', title: 'Lista que não é de consultas', meaning: 'O arquivo é uma lista [ ... ], mas os itens não são consultas (precisam ter query e field).', hint: 'Se for um arquivo de várias consultas, cada item precisa ter "query" e "field". Senão, envie as consultas em arquivos separados.' },
    RAIZ_ENCAPSULADA: { g: 'Estrutura', sev: 'erro', title: 'Consulta dentro de outra chave', meaning: 'A consulta existe, mas está dentro de uma chave (por exemplo { "data": { ... } }) e não na raiz.', hint: 'Exporte novamente ou mova o conteúdo para a raiz do arquivo.' },
    BIBLIOTECA_ITEM:  { g: 'Estrutura', sev: 'erro', title: 'Item inválido em uma biblioteca exportada', meaning: 'Em um arquivo de biblioteca (lista de consultas do QueryHub), este item não tem um raw_json válido.', hint: 'Corrija ou remova o item indicado e envie de novo.' },
    QUERY_AUSENTE:    { g: 'Estrutura', sev: 'erro', title: 'Falta o campo "query"', meaning: 'O JSON não tem o campo com o texto do SQL.', hint: 'O campo se chama "query". Confira se este é o arquivo exportado da consulta dinâmica.' },
    QUERY_TIPO:       { g: 'Estrutura', sev: 'erro', title: 'O campo "query" não é texto', meaning: 'O campo "query" existe, mas não é o texto do SQL (é número, lista, objeto etc.).', hint: 'O SQL precisa estar em "query" como texto entre aspas.' },
    QUERY_VAZIA:      { g: 'Estrutura', sev: 'erro', title: 'O campo "query" está vazio', meaning: 'O campo existe, mas não tem SQL.', hint: 'Abra a consulta na plataforma e confira se o SQL foi salvo antes de exportar.' },
    FIELD_AUSENTE:    { g: 'Estrutura', sev: 'erro', title: 'Falta o campo "field"', meaning: 'O JSON não tem a lista de campos (colunas e filtros).', hint: 'O campo se chama "field". Confira se este é o arquivo exportado da consulta dinâmica.' },
    FIELD_TIPO:       { g: 'Estrutura', sev: 'erro', title: 'O campo "field" não é uma lista', meaning: 'O campo "field" existe, mas não é uma lista [ ... ].', hint: '"field" precisa ser uma lista de objetos, um para cada coluna ou filtro.' },

    /* ----- Avisos de conteúdo (a consulta é importada) ----- */
    LISTA_EXPANDIDA:   { g: 'Conteúdo', sev: 'aviso', title: 'Arquivo com várias consultas', meaning: 'O arquivo era uma lista de consultas. Cada item virou uma consulta separada.', hint: 'Confira os nomes. Cada uma tem seu próprio download em JSON.' },
    NOME_AUSENTE:      { g: 'Conteúdo', sev: 'aviso', title: 'Consulta sem nome', meaning: 'O JSON não tem o campo "name".', hint: 'Foi usado o nome do arquivo. Edite o nome da consulta.' },
    NOME_TIPO:         { g: 'Conteúdo', sev: 'aviso', title: 'Nome em formato inesperado', meaning: 'O campo "name" não é um texto.', hint: 'Foi usado o nome do arquivo. Edite o nome da consulta.' },
    NOME_CURTO:        { g: 'Conteúdo', sev: 'aviso', title: 'Nome muito curto', meaning: 'O nome tem menos de 3 caracteres.', hint: 'Edite o nome para algo descritivo. O editor não aceita nomes com menos de 3 caracteres.' },
    NOME_LONGO:        { g: 'Conteúdo', sev: 'aviso', title: 'Nome muito longo', meaning: 'O nome tem mais de 160 caracteres.', hint: 'Edite o nome para algo mais curto. Nomes longos quebram o layout dos cards.' },
    FIELD_VAZIO:       { g: 'Conteúdo', sev: 'aviso', title: 'Lista de campos vazia', meaning: 'O campo "field" é uma lista vazia, sem colunas nem filtros.', hint: 'A consulta foi importada, mas sem colunas para mostrar. Confira a exportação.' },
    SEM_COLUNAS:       { g: 'Conteúdo', sev: 'aviso', title: 'Consulta sem colunas', meaning: 'Nenhum campo tem tipo 1 (coluna de retorno). Só há filtros ou campos de outro tipo.', hint: 'É normal para rotinas que não retornam dados. Se deveria retornar, confira o campo "tipo" dos campos.' },
    FIELD_ITEM_INVALIDO:{ g: 'Conteúdo', sev: 'aviso', title: 'Itens inválidos na lista de campos', meaning: 'Alguns itens de "field" não são objetos (são nulos, textos ou números) e foram ignorados.', hint: 'Confira a exportação. Esses itens não aparecem como colunas.' },
    CAMPO_SEM_NOME:    { g: 'Conteúdo', sev: 'aviso', title: 'Coluna sem nome', meaning: 'Há campos de coluna (tipo 1) sem o campo "name", ignorados.', hint: 'Cada coluna precisa de um "name". Confira a exportação.' },
    CAMPO_SEM_TIPO:    { g: 'Conteúdo', sev: 'aviso', title: 'Campo sem tipo', meaning: 'Há campos sem o valor "tipo". Eles não são tratados como colunas.', hint: 'As colunas de retorno têm "tipo": 1. Se estes campos deveriam ser colunas, confira a exportação.' },
    CAMPO_TIPO_INVALIDO:{ g: 'Conteúdo', sev: 'aviso', title: 'Campo com tipo inválido', meaning: 'O valor de "tipo" não é um número (por exemplo, é um texto).', hint: 'O "tipo" deve ser numérico. Estes campos não são tratados como colunas.' },
    COLUNA_DUPLICADA:  { g: 'Conteúdo', sev: 'aviso', title: 'Colunas com nome repetido', meaning: 'Duas ou mais colunas têm o mesmo "name". Só a primeira foi mantida.', hint: 'Colunas repetidas costumam indicar erro no SQL ou na exportação.' },
    MUITAS_COLUNAS:    { g: 'Conteúdo', sev: 'aviso', title: 'Quantidade de colunas muito alta', meaning: 'A consulta retorna mais de 250 colunas.', hint: 'Funciona, mas é raro. Confira se a consulta é essa mesma.' },
    PARAM_SEM_CAMPO:   { g: 'Conteúdo', sev: 'aviso', title: 'Filtro usado no SQL sem definição', meaning: 'O SQL usa um parâmetro (:nome) que não tem campo correspondente em "field".', hint: 'O filtro aparece com o tipo "data" por padrão. Confira se o tipo e o nome estão certos.' },
    PARAM_NAO_USADO:   { g: 'Conteúdo', sev: 'aviso', title: 'Filtro definido mas não usado no SQL', meaning: 'Há um campo de filtro (:nome) em "field" que o SQL não utiliza.', hint: 'Pode ser sobra de edição. Confira se o filtro deveria estar no SQL.' },
    PARAM_EM_TEXTO:    { g: 'Conteúdo', sev: 'aviso', title: 'Possível filtro falso (dentro de texto ou comentário)', meaning: 'Um ":nome" aparece só dentro de um texto entre aspas ou de um comentário do SQL.', hint: 'Foi contado como filtro, mas pode não ser um. Se não for, ignore.' },
    QUERY_SEM_COMANDO: { g: 'Conteúdo', sev: 'aviso', title: 'SQL sem comando reconhecido', meaning: 'Não encontrei SELECT, WITH, CALL ou outro comando SQL no texto.', hint: 'Confira se o campo "query" tem mesmo o SQL.' },
    COMANDO_ESCRITA:   { g: 'Conteúdo', sev: 'aviso', title: 'SQL que altera dados', meaning: 'O SQL tem comando de escrita (INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, MERGE, CREATE, GRANT ou REVOKE).', hint: 'Consultas da biblioteca costumam ser só de leitura. Confirme se é intencional antes de publicar para o time.' },
    MULTIPLOS_COMANDOS:{ g: 'Conteúdo', sev: 'aviso', title: 'Mais de um comando SQL', meaning: 'Há vários comandos separados por ponto e vírgula.', hint: 'Consultas dinâmicas costumam ter um único comando. Confira se está correto.' },
    QUERY_GRANDE:      { g: 'Conteúdo', sev: 'aviso', title: 'SQL muito grande', meaning: 'O SQL tem mais de 200 mil caracteres.', hint: 'Funciona, mas é muito incomum. Confira o arquivo.' },

    /* ----- Duplicidade ----- */
    DUP_LOTE:       { g: 'Duplicidade', sev: 'aviso', title: 'Nome de arquivo repetido no mesmo envio', meaning: 'Dois arquivos do envio tinham o mesmo nome. Os dois foram importados e o segundo foi renomeado.', hint: 'Confira se são mesmo consultas diferentes.' },
    MESMO_SQL:      { g: 'Duplicidade', sev: 'aviso', title: 'SQL idêntico ao de outra consulta', meaning: 'O SQL é igual ao de outra consulta (do mesmo envio ou já cadastrada).', hint: 'Pode ser cópia. Se for, considere manter só uma.' },
    NOME_REPETIDO:  { g: 'Duplicidade', sev: 'aviso', title: 'Nome igual ao de outra consulta', meaning: 'Existe outra consulta com o mesmo nome, mas com SQL diferente.', hint: 'Renomeie para o time conseguir distinguir as duas na busca.' },
    ATUALIZADA:     { g: 'Duplicidade', sev: 'info', title: 'Consulta existente atualizada', meaning: 'Já havia uma consulta com o mesmo nome de arquivo. O JSON foi atualizado; categorias, descrição e destaques foram mantidos.', hint: 'Nenhuma ação necessária. Se não era para atualizar, não publique.' }
  };

  function mk(code, detail, extra) {
    var def = ISSUES[code] || { sev: 'erro', title: code, hint: '' };
    var it = { code: code, sev: def.sev, title: def.title, hint: def.hint, detail: detail || '' };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) it[k] = extra[k];
    return it;
  }

  function isError(it) { return it.sev === 'erro'; }

  function describe(v) {
    if (v === null) return 'nulo (null)';
    if (Array.isArray(v)) return 'uma lista com ' + v.length + ' item(ns)';
    if (typeof v === 'object') return 'um objeto';
    if (typeof v === 'string') return 'um texto';
    if (typeof v === 'number') return 'um número';
    if (typeof v === 'boolean') return 'um valor verdadeiro/falso';
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

    if (first === '<') return out('JSON_HTML', 'O conteúdo começa com "<" (parece HTML).');
    if (/^(select|with|insert|update|delete|call|exec|execute)\b/i.test(trimmed)) return out('JSON_SQL_PURO', 'O conteúdo começa com "' + trimmed.split(/\s+/)[0].toUpperCase() + '", um comando SQL.');
    if (first !== '{' && first !== '[') return out('JSON_TEXTO_LIVRE', 'O conteúdo começa com "' + trimmed.slice(0, 20).replace(/\s+/g, ' ') + '" em vez de {.');
    if (/end of (json )?(input|data)|unexpected end|unexpected eof/i.test(msg) || (/unterminated string/i.test(msg) && pos != null && pos >= trimmed.length - 1) || (pos != null && pos >= trimmed.length)) {
      return out('JSON_TRUNCADO', 'O arquivo termina antes de o JSON ser fechado (' + trimmed.length + ' caracteres lidos).');
    }
    if (tryParse(REPAIRS.comentario(body))) return out('JSON_COMENTARIO', 'Foram encontrados comentários no arquivo' + where + '.');
    if (tryParse(REPAIRS.virgula(body))) return out('JSON_VIRGULA', 'Há uma vírgula sobrando antes de } ou ]' + where + '.');
    if (tryParse(REPAIRS.multiplos(body))) return out('JSON_MULTIPLOS', 'O arquivo tem mais de um objeto JSON seguido' + where + '.');
    if (tryParse(REPAIRS.quebra(body))) return out('JSON_QUEBRA_LINHA', 'Há quebra de linha real dentro de um texto entre aspas' + where + '.');
    if (tryParse(REPAIRS.escape(body))) return out('JSON_ESCAPE', 'Há uma barra invertida sem escape dentro de um texto' + where + '.');
    if (tryParse(REPAIRS.valor(body))) return out('JSON_VALOR_INVALIDO', 'O arquivo usa undefined, NaN ou Infinity' + where + '.');
    if (tryParse(REPAIRS.chave(body))) return out('JSON_CHAVE_SEM_ASPAS', 'Há um nome de campo sem aspas' + where + '.');
    if (tryParse(REPAIRS.aspas(body))) return out('JSON_ASPAS', 'O arquivo usa aspas simples' + where + '.');
    var combined = REPAIRS.virgula(REPAIRS.chave(REPAIRS.aspas(REPAIRS.comentario(body))));
    if (tryParse(combined)) return out('JSON_FORMATO_JS', 'O conteúdo parece um objeto JavaScript' + where + '.');
    if (/control character|unterminated|newline/i.test(msg)) return out('JSON_QUEBRA_LINHA', 'Há um caractere de controle ou texto sem fechamento' + where + '.');
    if (/escape/i.test(msg)) return out('JSON_ESCAPE', 'Há um caractere de escape inválido' + where + '.');
    return out('JSON_SINTAXE', 'O JSON tem um erro de sintaxe' + where + '.');
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
    if (fields.length === 0) issues.push(mk('FIELD_VAZIO', 'A lista "field" não tem nenhum item.'));
    else if (cols.length === 0) issues.push(mk('SEM_COLUNAS', 'Nenhum dos ' + fields.length + ' campos tem tipo 1 (coluna).'));
    if (nonObj.length) issues.push(mk('FIELD_ITEM_INVALIDO', nonObj.length + ' item(ns) de "field" não são objetos (posições: ' + listNames(nonObj) + ').'));
    if (noName.length) issues.push(mk('CAMPO_SEM_NOME', noName.length + ' coluna(s) sem "name" (posições: ' + listNames(noName) + ').'));
    if (noTipo.length) issues.push(mk('CAMPO_SEM_TIPO', noTipo.length + ' campo(s) sem "tipo": ' + listNames(noTipo) + '.'));
    if (badTipo.length) issues.push(mk('CAMPO_TIPO_INVALIDO', 'Campo(s) com "tipo" que não é número: ' + listNames(badTipo) + '.'));
    if (dups.length) issues.push(mk('COLUNA_DUPLICADA', 'Colunas repetidas (só a primeira foi mantida): ' + listNames(dups) + '.'));
    if (cols.length > WARN_COLUMNS) issues.push(mk('MUITAS_COLUNAS', 'A consulta tem ' + cols.length + ' colunas.'));

    var semCampo = rawParams.filter(function (p) { return !declared[p.toLowerCase()]; });
    if (semCampo.length) issues.push(mk('PARAM_SEM_CAMPO', 'Parâmetro(s) usados no SQL sem campo em "field": ' + semCampo.map(function (p) { return ':' + p; }).join(', ') + '.'));

    var emTexto = rawParams.filter(function (p) { return cleanParams.indexOf(p) === -1; });
    if (emTexto.length) issues.push(mk('PARAM_EM_TEXTO', 'Só aparece dentro de texto ou comentário: ' + emTexto.map(function (p) { return ':' + p; }).join(', ') + '.'));

    var naoUsados = fields.filter(function (f) {
      return f && typeof f === 'object' && typeof f.name === 'string' && f.name.charAt(0) === ':' && rawParams.map(function (p) { return p.toLowerCase(); }).indexOf(f.name.slice(1).toLowerCase()) === -1;
    }).map(function (f) { return f.name; });
    if (naoUsados.length) issues.push(mk('PARAM_NAO_USADO', 'Filtro(s) definidos e não usados no SQL: ' + listNames(naoUsados) + '.'));

    var clean = stripSql(sql);
    if (!/\b(select|with|insert|update|delete|call|exec|execute|show|values|table|merge|explain|create|drop|alter|truncate)\b/i.test(clean)) {
      issues.push(mk('QUERY_SEM_COMANDO', 'Não foi encontrado nenhum comando SQL no texto de "query".'));
    }
    var writes = clean.match(/\b(insert|update|delete|drop|truncate|alter|merge|create|grant|revoke)\b/gi);
    if (writes) {
      var uniq = []; writes.forEach(function (w) { w = w.toUpperCase(); if (uniq.indexOf(w) === -1) uniq.push(w); });
      issues.push(mk('COMANDO_ESCRITA', 'Comando(s) encontrados: ' + uniq.join(', ') + '.'));
    }
    if (/;\s*\S/.test(clean.trim())) issues.push(mk('MULTIPLOS_COMANDOS', 'Há texto depois de um ponto e vírgula, o que indica mais de um comando.'));
    if (sql.length > WARN_QUERY_CHARS) issues.push(mk('QUERY_GRANDE', 'O SQL tem ' + sql.length + ' caracteres.'));

    var name;
    if (typeof data.name === 'string' && data.name.trim()) name = data.name.trim();
    else {
      name = fileName.replace(/\.json$/i, '');
      if (data.name === undefined || data.name === null || data.name === '') issues.push(mk('NOME_AUSENTE', 'Foi usado o nome do arquivo: "' + name + '".'));
      else issues.push(mk('NOME_TIPO', 'O campo "name" é ' + describe(data.name) + '. Foi usado o nome do arquivo: "' + name + '".'));
    }
    if (name.length < 3) issues.push(mk('NOME_CURTO', 'O nome "' + name + '" tem ' + name.length + ' caractere(s).'));
    if (name.length > 160) issues.push(mk('NOME_LONGO', 'O nome tem ' + name.length + ' caracteres.'));

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
      issues.push(mk('RAIZ_TIPO', 'O conteúdo é ' + describe(data) + ', mas era esperado um objeto { ... }.'));
      return { q: null, issues: issues };
    }
    var hasQ = data.query !== undefined, hasF = data.field !== undefined;

    if (!hasQ && !hasF) {
      var inner = Object.keys(data).filter(function (k) { return looksLikeConsulta(data[k]); })[0];
      if (inner) {
        issues.push(mk('RAIZ_ENCAPSULADA', 'A consulta está dentro da chave "' + inner + '".'));
        return { q: null, issues: issues };
      }
    }

    if (!hasQ) {
      var altQ = findKey(data, ['query', 'sql', 'consulta', 'script', 'statement', 'querytext', 'query_text']);
      issues.push(mk('QUERY_AUSENTE', 'O arquivo não tem o campo "query".' + (Object.keys(data).length ? ' Campos encontrados: ' + listNames(Object.keys(data), 10) + '.' : ' O objeto está vazio.'),
        altQ ? { hint: 'Encontrei a chave "' + altQ + '", mas o campo esperado se chama "query". Confira se este é o arquivo exportado da consulta dinâmica.' } : null));
    } else if (typeof data.query !== 'string') {
      issues.push(mk('QUERY_TIPO', 'O campo "query" é ' + describe(data.query) + '.'));
    } else if (!data.query.trim()) {
      issues.push(mk('QUERY_VAZIA', 'O campo "query" tem só espaços ou está em branco.'));
    }

    if (!hasF) {
      var altF = findKey(data, ['field', 'fields', 'campos', 'columns', 'colunas']);
      issues.push(mk('FIELD_AUSENTE', 'O arquivo não tem o campo "field".',
        altF ? { hint: 'Encontrei a chave "' + altF + '", mas o campo esperado se chama "field". Confira se este é o arquivo exportado da consulta dinâmica.' } : null));
    } else if (!Array.isArray(data.field)) {
      issues.push(mk('FIELD_TIPO', 'O campo "field" é ' + describe(data.field) + '.'));
    }

    if (issues.some(isError)) return { q: null, issues: issues };
    return { q: buildQuery(data, fileName, issues), issues: issues };
  }

  function normalizeLibraryItem(item, i) {
    var label = 'Item ' + (i + 1) + ': ';
    if (!item || typeof item !== 'object' || !item.raw_json || typeof item.raw_json !== 'object') {
      return { q: null, issues: [mk('BIBLIOTECA_ITEM', label + 'não tem "raw_json" válido.')] };
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
    if (!text.trim()) return { results: [], issues: [mk('ARQ_VAZIO', 'O arquivo não tem conteúdo.')] };
    if (text.length > MAX_FILE_CHARS) return { results: [], issues: [mk('ARQ_GRANDE', 'O arquivo tem ' + (text.length / 1048576).toFixed(1) + ' MB e o limite é 8 MB.')] };
    if (text.indexOf('\uFFFD') !== -1) pre.push(mk('ARQ_ENCODING', 'O texto contém o caractere � (acentos perdidos).'));
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
        issues.push(mk('LISTA_EXPANDIDA', 'O arquivo tinha ' + data.length + ' consultas; cada uma virou uma consulta separada.'));
        return { results: results, issues: issues };
      }
      var sample = data.length ? 'O primeiro item é ' + describe(data[0]) + '.' : 'A lista está vazia.';
      return { results: [], issues: pre.concat([mk('RAIZ_LISTA', 'O arquivo é uma lista com ' + data.length + ' item(ns). ' + sample)]) };
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
        r.issues.push(mk('DUP_LOTE', 'Já havia um arquivo chamado "' + base + '" neste envio (' + fileOwner[base] + '). Esta cópia foi importada como "' + nn + '".'));
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
        if (other) r.issues.push(mk('NOME_REPETIDO', 'Já existe uma consulta chamada "' + q.name + '" (arquivo "' + other + '") com SQL diferente.'));
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

  /* ---------- Relatório de importação ---------- */
  var REPORT_KEY = 'queryhub:last-report:v1';
  var SEV_LABEL = { erro: 'Erro', aviso: 'Aviso', info: 'Info', ignorado: 'Ignorado' };

  function buildReport(an, source, counts) {
    var items = an.items.slice(), withWarn = 0;
    an.results.forEach(function (r) {
      var warns = r.issues.filter(function (i) { return i.sev !== 'erro'; });
      if (warns.some(function (i) { return i.sev === 'aviso'; })) withWarn++;
      var id = r.finalId || r.q.id;
      state.warnById[id] = warns;
      warns.forEach(function (w) {
        var it = stamp(Object.assign({}, w), r.path);
        it.queryId = id;
        it.queryName = r.q.name;
        items.push(it);
      });
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

  function saveReport() {
    var r = state.report;
    if (!r) return;
    try {
      var slim = {
        id: r.id, createdAt: r.createdAt, source: r.source, totals: r.totals,
        items: r.items.slice(0, 3000).map(function (i) {
          return { code: i.code, sev: i.sev, title: i.title, hint: i.hint, detail: String(i.detail || '').slice(0, 400), tech: String(i.tech || '').slice(0, 200), snippet: String(i.snippet || '').slice(0, 200), line: i.line, col: i.col, path: i.path, file: i.file, queryId: i.queryId, queryName: i.queryName };
        })
      };
      localStorage.setItem(REPORT_KEY, JSON.stringify(slim));
    } catch (err) { /* sem espaço: o relatório fica só na memória */ }
  }

  function loadReport() {
    try { state.report = JSON.parse(localStorage.getItem(REPORT_KEY) || 'null'); } catch (err) { state.report = null; }
    updateReportButton();
  }

  function updateReportButton() {
    var btn = $('btnReport');
    if (!btn) return;
    var r = state.report;
    btn.classList.toggle('hidden', !r);
    if (r) $('reportBadge').textContent = r.totals.comErro ? String(r.totals.comErro) : '';
    if (r) $('reportBadge').classList.toggle('hidden', !r.totals.comErro);
  }

  function warningsFor(q) {
    if (state.warnById[q.id]) return state.warnById[q.id];
    var r = state.report;
    if (!r) return [];
    return r.items.filter(function (i) { return i.queryId === q.id && (i.sev === 'aviso' || i.sev === 'info'); });
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
    if (tab) state.reportTab = tab;
    $('reportSearch').value = '';
    renderReport();
    openModal($('reportModal'));
  }

  function rowHtml(it) {
    var cat = ISSUES[it.code] || {};
    var h = '<div class="irow"><div class="irow__top"><code>' + esc(it.path || it.file || '') + '</code>';
    if (it.queryId && findQuery(it.queryId)) h += '<button type="button" class="link-btn" data-open-query="' + esc(it.queryId) + '">Abrir consulta</button>';
    h += '</div><div class="irow__detail">' + esc(it.detail) + '</div>';
    if (it.line) h += '<div class="irow__where">Linha ' + it.line + ', coluna ' + it.col + '</div>';
    if (it.snippet) h += '<pre class="snippet">' + esc(it.snippet) + '</pre>';
    if (it.hint && it.hint !== cat.hint) h += '<div class="irow__hint">' + esc(it.hint) + '</div>';
    if (it.tech) h += '<div class="irow__tech">Mensagem técnica: ' + esc(it.tech) + '</div>';
    return h + '</div>';
  }

  function fillGroup(det) {
    var code = det.getAttribute('data-code'), list = reportGroups[code] || [];
    var body = det.querySelector('.igroup__body'), shown = Number(det.getAttribute('data-shown') || 0), step = 100;
    var more = body.querySelector('[data-more]');
    if (more) more.remove();
    var html = list.slice(shown, shown + step).map(rowHtml).join('');
    body.insertAdjacentHTML('beforeend', html);
    shown = Math.min(list.length, shown + step);
    det.setAttribute('data-shown', String(shown));
    if (shown < list.length) {
      body.insertAdjacentHTML('beforeend', '<button type="button" class="btn btn--sm" data-more="' + esc(code) + '">Mostrar mais (' + (list.length - shown) + ' restantes)</button>');
    }
  }

  function renderReport() {
    var r = state.report;
    if (!r) return;
    var tab = state.reportTab || 'erro', t = r.totals;
    $('reportSub').textContent = r.source + ' · ' + formatDate(r.createdAt);

    $('reportSummary').innerHTML = [
      ['Arquivos lidos', t.lidos, ''], ['Importadas', t.importadas, 'ok'], ['Com aviso', t.comAviso, 'warn'],
      ['Com erro', t.comErro, 'err'], ['Ignorados', t.ignorados, ''], ['Atualizadas', t.atualizadas, '']
    ].map(function (c) { return '<div class="rsum rsum--' + c[2] + '"><b>' + c[1] + '</b><span>' + c[0] + '</span></div>'; }).join('');

    var counts = { erro: 0, aviso: 0, ignorado: 0 };
    r.items.forEach(function (i) { counts[reportTabOf(i)]++; });
    document.querySelectorAll('.rtab').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-rtab') === tab);
      b.querySelector('em').textContent = counts[b.getAttribute('data-rtab')];
    });

    var term = normalize($('reportSearch').value), groups = {}, order = [];
    r.items.filter(function (i) {
      if (reportTabOf(i) !== tab) return false;
      return !term || normalize([i.path, i.detail, i.title, i.code].join(' ')).indexOf(term) !== -1;
    }).forEach(function (i) {
      if (!groups[i.code]) { groups[i.code] = []; order.push(i.code); }
      groups[i.code].push(i);
    });
    order.sort(function (a, b) { return groups[b].length - groups[a].length; });
    reportGroups = groups;

    var box = $('reportList');
    if (!order.length) {
      box.innerHTML = '<p class="muted-text rempty">' + (term ? 'Nada encontrado para essa busca.' : tab === 'erro' ? 'Nenhum erro neste envio.' : tab === 'aviso' ? 'Nenhum aviso neste envio.' : 'Nenhum arquivo ignorado neste envio.') + '</p>';
      return;
    }
    box.innerHTML = order.map(function (code) {
      var d = ISSUES[code] || { title: code, meaning: '', hint: '', sev: 'erro' };
      return '<details class="igroup" data-code="' + esc(code) + '" data-shown="0"><summary>' +
        '<span class="sev sev--' + d.sev + '">' + SEV_LABEL[d.sev] + '</span><strong>' + esc(d.title) + '</strong><em>' + groups[code].length + '</em></summary>' +
        '<div class="igroup__body"><p class="igroup__meaning">' + esc(d.meaning) + '</p><p class="igroup__hint"><b>Como resolver:</b> ' + esc(d.hint) + '</p></div></details>';
    }).join('');

    box.querySelectorAll('details.igroup').forEach(function (det) {
      det.addEventListener('toggle', function () { if (det.open && !Number(det.getAttribute('data-shown'))) fillGroup(det); });
    });
    var firstGroup = box.querySelector('details.igroup');
    if (firstGroup && (order.length <= 3 || term)) firstGroup.open = true;
  }

  function csvEscape(v) {
    v = String(v == null ? '' : v);
    return /[";\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function reportCsv() {
    var r = state.report;
    if (!r) return;
    var lines = [['arquivo', 'caminho', 'gravidade', 'codigo', 'mensagem', 'detalhe', 'como_resolver', 'linha', 'coluna', 'trecho'].join(';')];
    r.items.forEach(function (i) {
      lines.push([i.file, i.path, i.sev, i.code, i.title, i.detail, i.hint, i.line || '', i.col || '', i.snippet || ''].map(csvEscape).join(';'));
    });
    download('relatorio_importacao.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function reportCopy() {
    var r = state.report;
    if (!r) return;
    var t = r.totals, lines = ['Relatório de importação – ' + r.source + ' (' + formatDate(r.createdAt) + ')',
      t.lidos + ' arquivos lidos · ' + t.importadas + ' importadas · ' + t.comAviso + ' com aviso · ' + t.comErro + ' com erro · ' + t.ignorados + ' ignorados', ''];
    r.items.filter(function (i) { return i.sev === 'erro'; }).forEach(function (i) {
      lines.push('• ' + i.path + ' – ' + i.title + ': ' + i.detail + (i.line ? ' [linha ' + i.line + ']' : ''));
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
      return '<h3 class="guide__group">' + esc(g) + '</h3><div class="guide__wrap"><table class="guide"><thead><tr><th>Tipo</th><th>Mensagem</th><th>O que significa</th><th>Como resolver</th></tr></thead><tbody>' +
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

  function registerReport(an, source, counts) {
    state.report = buildReport(an, source, counts);
    saveReport();
    updateReportButton();
    return state.report;
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
        return e.title + '\n' + e.detail + (e.line ? ' [linha ' + e.line + ']' : '') + (e.snippet ? '\ntrecho: ' + e.snippet : '') + '\n\u2192 ' + e.hint;
      });
      if (!lines.length) lines = an.items.slice(0, 3).map(function (e) { return e.title + ': ' + e.detail; });
      setStatus(lines.join('\n\n') + (lines.length ? '\n\n(O relatório completo está no botão "Relatório" no topo.)' : ''));
      registerReport(an, describeSource(files), { added: 0, updated: 0 });
      return;
    }
    if (an.results.length === 1 && !an.results[0].keep && !errs.length) {
      var r = an.results[0];
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
      r.issues.push(mk('ATUALIZADA', 'Já existia uma consulta do arquivo "' + r.q.source_filename + '".'));
    });
    return { added: a.added + b.added, updated: a.updated + b.updated };
  }

  /* ==========================================================================
     Revisão da biblioteca (fila de pendências)
     ========================================================================== */
  function hasDesc(q) { return !!(q.description && String(q.description).trim()); }
  function onlyOthers(q) { var c = q.categories || []; return !c.length || (c.length === 1 && c[0] === 'Outros'); }
  function isPending(q) { return !hasDesc(q) || onlyOthers(q); }

  var warnCache = { id: null, set: {} };
  function warnSet() {
    var r = state.report;
    if (!r) return {};
    if (warnCache.id === r.id) return warnCache.set;
    var set = {};
    r.items.forEach(function (i) { if (i.sev === 'aviso' && i.queryId) set[i.queryId] = true; });
    warnCache = { id: r.id, set: set };
    return set;
  }

  QH.reviewMatch = function (q, mode) {
    if (mode === 'pending') return isPending(q);
    if (mode === 'nodesc') return !hasDesc(q);
    if (mode === 'others') return onlyOthers(q);
    if (mode === 'warn') return !!warnSet()[q.id];
    return true;
  };

  function setReview(mode) {
    state.review = mode;
    $('reviewFilter').value = mode;
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
    $('reviewCount').textContent = total ? (pending ? ready + ' de ' + total + ' consultas prontas (com descrição e categoria definida)' : 'Tudo revisado: ' + total + ' consultas prontas ✓') : '';
    $('reviewFill').style.width = (total ? Math.round(ready / total * 100) : 0) + '%';
    var items = [['pending', 'Pendentes', pending], ['nodesc', 'Sem descrição', nodesc], ['others', 'Só em "Outros"', others], ['warn', 'Com aviso', warn]];
    $('reviewChips').innerHTML = items.map(function (it) {
      return '<button type="button" class="chip chip--review' + (state.review === it[0] ? ' is-active' : '') + '" data-review="' + it[0] + '">' + esc(it[1]) + ' <span class="chip__count">' + it[2] + '</span></button>';
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

  function openPublishSummary() {
    if (state.publishing) return;
    ensureBaseline().then(function () {
      var d = computeDiff(), total = state.queries.length;
      if (!d.total) { toast('Não há alterações para publicar.'); return; }
      var warn = $('pubWarn'), warnText = '';
      if (!total) warnText = 'ATENÇÃO: a biblioteca está VAZIA. Publicar vai apagar TODAS as consultas do site do time.';
      else if (baseline && d.removed.length >= 10 && d.removed.length / Math.max(1, Object.keys(baseline.sigs).length) >= 0.3) {
        warnText = 'Você está removendo ' + d.removed.length + ' de ' + Object.keys(baseline.sigs).length + ' consultas publicadas. Confira a lista abaixo.';
      }
      warn.classList.toggle('hidden', !warnText);
      warn.textContent = warnText;
      var onlyIds = !d.unknown && !d.added.length && !d.removed.length && d.changed.length && d.changed.every(function (c) { return c.why.length === 1 && c.why[0] === 'ID'; });
      $('pubSub').textContent = onlyIds ? 'Esta publicação só atribui um número (ID) às consultas que já existiam. Nada mais muda para o time.' : 'Confira o que vai mudar. O site atualiza em cerca de 1 minuto.';

      if (d.unknown) {
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
      toast('Publicado! O time verá as mudanças em cerca de 1 minuto, quando o deploy terminar.');
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
    on('btnPublish', 'click', openPublishSummary);
    on('btnPublishMenu', 'click', openPublishSummary);
    on('pubConfirm', 'click', doPublish);
    on('pubBarUndo', 'click', undo);
    on('btnUndo', 'click', undo);
    on('btnDiscard', 'click', discardDraft);
    on('menuGuide', 'click', openGuide);

    on('reviewFilter', 'change', function (e) { setReview(e.target.value); });
    on('reviewChips', 'click', function (e) {
      var b = e.target.closest('[data-review]');
      if (b) setReview(state.review === b.getAttribute('data-review') ? '' : b.getAttribute('data-review'));
    });

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
    on('reportList', 'click', function (e) {
      var open = e.target.closest('[data-open-query]');
      if (open) {
        var q = findQuery(open.getAttribute('data-open-query'));
        if (q) { closeModal($('reportModal')); openEditor(q, false); }
        return;
      }
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

  QH.hooks.bind = bindAdmin;

  // Para testes e depuração
  QH.admin = {
    inspectText: inspectText, runImport: runImport, applyImport: applyImport, buildReport: buildReport, ISSUES: ISSUES,
    computeDiff: computeDiff, undo: undo, makeBaseline: makeBaseline, getBaseline: function () { return baseline; },
    undoDepth: function () { return undoStack.length; }, isPending: isPending
  };

})();
