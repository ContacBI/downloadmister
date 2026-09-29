/*
 * Baixa as regras de todas as empresas do Mister Contador.
 * Só faz leituras (GET). Não usa nenhuma chamada de exclusão ou edição.
 *
 * Como usar: veja o README.md. Cole este arquivo inteiro no Console (F12)
 * da página app.mistercontador.com.br, já logado.
 */
(async () => {
  const API = "https://core.mistercontador.com.br/api";
  const PAGE_SIZE = 200;
  const DELAY_MS = 300;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 1. captura os cabeçalhos que o próprio site usa (token incluso) ----
  const capturado = {};
  const guardar = (k, v) => {
    const key = String(k).toLowerCase();
    if (["authorization", "tenant-uuid", "sistema"].includes(key)) capturado[key] = v;
  };
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSet = XMLHttpRequest.prototype.setRequestHeader;
  const fetchOriginal = window.fetch;
  XMLHttpRequest.prototype.open = function (m, url) {
    this.__mrUrl = String(url);
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__mrUrl && this.__mrUrl.includes("core.mistercontador.com.br")) guardar(k, v);
    return xhrSet.apply(this, arguments);
  };
  window.fetch = function (url, init) {
    try {
      if (String(url).includes("core.mistercontador.com.br") && init && init.headers) {
        const h = init.headers;
        if (h instanceof Headers) h.forEach((v, k) => guardar(k, v));
        else Object.entries(h).forEach(([k, v]) => guardar(k, v));
      }
    } catch (e) { /* ignora */ }
    return fetchOriginal.apply(this, arguments);
  };

  console.log("%cPasso 1: clique numa página da lista de Regras (ex.: página 2) para o script pegar o acesso.", "font-weight:bold");
  const limite = Date.now() + 3 * 60 * 1000;
  while (!capturado.authorization && Date.now() < limite) await sleep(300);
  XMLHttpRequest.prototype.open = xhrOpen;
  XMLHttpRequest.prototype.setRequestHeader = xhrSet;
  window.fetch = fetchOriginal;
  if (!capturado.authorization) {
    console.error("Não consegui pegar o acesso. Rode de novo e clique numa página da lista de Regras.");
    return;
  }
  console.log("Acesso capturado. Iniciando...");

  const headers = () => ({
    accept: "application/json, text/plain, */*",
    authorization: capturado.authorization,
    sistema: capturado.sistema || "DOMINIO_SISTEMAS",
    ...(capturado["tenant-uuid"] ? { "tenant-uuid": capturado["tenant-uuid"] } : {}),
  });

  async function get(path) {
    for (let tentativa = 1; tentativa <= 4; tentativa++) {
      const r = await fetch(API + path, { method: "GET", headers: headers() });
      if (r.status === 401) throw Object.assign(new Error("Acesso expirou (401). Faça login de novo e rode o script outra vez."), { fatal: true });
      if (r.ok) return { data: await r.json(), total: r.headers.get("x-total-count") };
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * tentativa); continue; }
      throw Object.assign(new Error(`HTTP ${r.status} em ${path}`), { status: r.status });
    }
    throw new Error(`Falhou após várias tentativas: ${path}`);
  }

  // ---- 2. lista de empresas ----
  // paginação genérica: a mesma lógica serve para empresas e regras
  async function paginar(montarPath, size, parouCurto) {
    const todas = [], vistos = new Set();
    let total = null;
    for (let page = 0; ; page++) {
      const { data, total: t } = await get(montarPath(page, size));
      if (t !== null) total = Number(t);
      if (!Array.isArray(data) || !data.length) break;
      const novas = data.filter((r) => !vistos.has(r.id));
      novas.forEach((r) => vistos.add(r.id));
      todas.push(...novas);
      if (!novas.length || (parouCurto && data.length < size)) break;
      await sleep(DELAY_MS);
    }
    return { todas, total };
  }

  // tenta com página grande; se o servidor limitar o tamanho, refaz com o tamanho menor
  async function paginarTudo(montarPath, pequeno) {
    let res = await paginar(montarPath, PAGE_SIZE, true);
    // sem o total do servidor não dá para saber se a página foi cortada: confere com o tamanho pequeno
    if (res.total !== null ? res.todas.length < res.total : true) {
      const conferido = await paginar(montarPath, pequeno, false);
      if (conferido.todas.length > res.todas.length) res = { ...conferido, total: res.total };
    }
    return res;
  }

  const resposta = prompt("IDs das empresas separados por vírgula (ex.: 9,12,15).\nDeixe vazio para baixar TODAS as empresas ativas.\nDica: teste primeiro só com o 9.", "9");
  if (resposta === null) return;
  let lista = [];
  try {
    const r = await paginarTudo((page, size) => `/parceiros?page=${page}&size=${size}&enabled.equals=true&sort=id,asc`, 9);
    lista = r.todas;
    console.log(`Empresas ativas encontradas: ${lista.length}${r.total !== null ? ` (o sistema informa ${r.total})` : ""}`);
  } catch (e) {
    if (e.fatal) throw e;
    console.warn("Não consegui listar as empresas: " + e.message);
  }
  const empresaPorId = new Map(lista.map((e) => [String(e.id), e]));
  const ids = resposta.trim() ? resposta.split(",").map((x) => x.trim()).filter(Boolean) : lista.map((e) => String(e.id));
  if (!ids.length) {
    console.error("Nenhuma empresa para baixar. Rode de novo e informe os IDs.");
    return;
  }

  // ---- 3. baixa as regras de cada empresa ----
  async function regrasDaEmpresa(id) {
    const res = await paginarTudo(
      (page, size) => `/regras?page=${page}&size=${size}&parceiroId.equals=${id}&sort=id,asc`, 20);
    if (res.total !== null && res.todas.length !== res.total) {
      console.warn(`  Atenção: empresa ${id} veio com ${res.todas.length} de ${res.total} regras.`);
    }
    return res.todas;
  }

  const s = (v) => (v === null || v === undefined ? "" : String(v));
  const simNao = (v) => (v === true ? "Sim" : v === false ? "Não" : "");
  const TIPOS = { HISTORICO: "Histórico" };
  const serialData = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000) : null;
  };
  const COLUNAS_REGRAS = [
    { titulo: "Descrição", tipo: "texto" }, { titulo: "Histórico", tipo: "texto" },
    { titulo: "Data de cadastro", tipo: "data" }, { titulo: "D/C", tipo: "dc" },
    { titulo: "Tipo de regra", tipo: "centro" }, { titulo: "Conta", tipo: "centro" },
    { titulo: "Classificação da conta", tipo: "texto" }, { titulo: "Nome da conta", tipo: "texto" },
    { titulo: "Banco", tipo: "texto" }, { titulo: "Agência", tipo: "centro" },
    { titulo: "Conta bancária", tipo: "centro" }, { titulo: "Descrição da conta bancária", tipo: "texto" },
    { titulo: "Histórico do extrato", tipo: "centro" }, { titulo: "Aplicação", tipo: "centro" },
    { titulo: "ID da regra", tipo: "centro" },
  ];
  function linhaRegra(r) {
    const ag = r.agenciabancaria;
    const c = r.conta || {};
    return [
      s(r.regDescricao), s(r.regHistorico), serialData(r.dataCadastro), r.debito ? "D" : "C",
      TIPOS[r.tipoRegra] || s(r.tipoRegra), c.conConta === undefined ? "" : c.conConta,
      s(c.conClassificacao), s(c.conDescricao),
      ag ? s(ag.banco && ag.banco.banDescricao) : "Todas", ag ? s(ag.ageAgencia) : "",
      ag && ag.ageNumero ? `${ag.ageNumero}${ag.ageDigito ? "-" + ag.ageDigito : ""}` : "",
      ag ? s(ag.ageDescricao) : "", simNao(r.manterHistorico), simNao(r.aplicacao), r.id,
    ];
  }

  function baixar(nome, conteudo, tipo) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // nome seguro para pasta/arquivo: sem acentos nem caracteres proibidos
  function nomeBase(razao, id) {
    const base = String(razao || "empresa").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
    return `${base || "empresa"} - ${id}`;
  }

  // achata um objeto em colunas "a.b.c" (para o resumo das empresas)
  function achatarObj(o, prefixo, saida) {
    Object.entries(o || {}).forEach(([k, v]) => {
      const chave = prefixo ? `${prefixo}.${k}` : k;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) achatarObj(v, chave, saida);
      else saida[chave] = Array.isArray(v) ? JSON.stringify(v) : s(v);
    });
    return saida;
  }

  // ZIP simples (sem compressão), com nomes em UTF-8: uma pasta por empresa
  const TABELA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = TABELA_CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  function montarZip(arquivos) {
    const enc = new TextEncoder();
    const agora = new Date();
    const hora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | (agora.getSeconds() >> 1);
    const dia = ((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();
    const locais = [], central = [];
    let deslocamento = 0;
    for (const f of arquivos) {
      const nome = enc.encode(f.nome), tam = f.dados.length, crc = crc32(f.dados);
      const l = new DataView(new ArrayBuffer(30));
      l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true);
      l.setUint16(10, hora, true); l.setUint16(12, dia, true); l.setUint32(14, crc, true);
      l.setUint32(18, tam, true); l.setUint32(22, tam, true); l.setUint16(26, nome.length, true);
      locais.push(new Uint8Array(l.buffer), nome, f.dados);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(12, hora, true); c.setUint16(14, dia, true); c.setUint32(16, crc, true);
      c.setUint32(20, tam, true); c.setUint32(24, tam, true); c.setUint16(28, nome.length, true);
      c.setUint32(42, deslocamento, true);
      central.push(new Uint8Array(c.buffer), nome);
      deslocamento += 30 + nome.length + tam;
    }
    const tamCentral = central.reduce((a, x) => a + x.length, 0);
    const fim = new DataView(new ArrayBuffer(22));
    fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, arquivos.length, true); fim.setUint16(10, arquivos.length, true);
    fim.setUint32(12, tamCentral, true); fim.setUint32(16, deslocamento, true);
    const partes = [...locais, ...central, new Uint8Array(fim.buffer)];
    const saida = new Uint8Array(partes.reduce((a, x) => a + x.length, 0));
    let pos = 0;
    for (const x of partes) { saida.set(x, pos); pos += x.length; }
    return saida;
  }


  // ---- planilha .xlsx formatada (cabeçalho colorido, filtro, painel congelado) ----
  const xmlEsc = (v) => String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const letra = (n) => {
    let t = "";
    for (n++; n > 0; n = Math.floor((n - 1) / 26)) t = String.fromCharCode(65 + ((n - 1) % 26)) + t;
    return t;
  };
  const celula = (ref, valor, estilo) => {
    if (valor === null || valor === undefined || valor === "") return `<c r="${ref}" s="${estilo}"/>`;
    if (typeof valor === "number") return Number.isFinite(valor) ? `<c r="${ref}" s="${estilo}"><v>${valor}</v></c>` : `<c r="${ref}" s="${estilo}"/>`;
    return `<c r="${ref}" s="${estilo}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(valor)}</t></is></c>`;
  };
  // estilos (índices em ESTILOS_XML): 1 título, 2 subtítulo, 3 cabeçalho, 4/5 texto, 6/7 data, 8/9 centro, 10 D, 11 C
  const estiloDe = (tipo, valor, zebra) =>
    tipo === "dc" ? (valor === "D" ? 10 : 11) : ({ texto: 4, data: 6, centro: 8 }[tipo] || 4) + (zebra ? 1 : 0);

  function planilhaXml(pl) {
    const ncol = pl.colunas.length;
    const cab = 4; // linha do cabeçalho
    const larguras = pl.colunas.map((c, i) => {
      let m = c.titulo.length + 3;
      pl.linhas.slice(0, 500).forEach((l) => { m = Math.max(m, String(l[i] === null || l[i] === undefined ? "" : l[i]).length + 2); });
      return Math.min(c.max || 60, Math.max(c.min || 10, m));
    });
    const linhas = [];
    linhas.push(`<row r="1" ht="26" customHeight="1">${celula("A1", pl.titulo, 1)}</row>`);
    linhas.push(`<row r="2">${celula("A2", pl.subtitulo, 2)}</row>`);
    linhas.push(`<row r="${cab}" ht="32" customHeight="1">${pl.colunas.map((c, i) => celula(letra(i) + cab, c.titulo, 3)).join("")}</row>`);
    pl.linhas.forEach((l, k) => {
      const r = cab + 1 + k;
      linhas.push(`<row r="${r}">${pl.colunas.map((c, i) => celula(letra(i) + r, l[i], estiloDe(c.tipo, l[i], k % 2 === 1))).join("")}</row>`);
    });
    const ultima = cab + Math.max(pl.linhas.length, 1);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${letra(ncol - 1)}${ultima}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="${cab}" topLeftCell="A${cab + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${larguras.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${linhas.join("")}</sheetData><autoFilter ref="A${cab}:${letra(ncol - 1)}${ultima}"/><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  }

  const ESTILOS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="7"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="16"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font><font><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFC00000"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF375623"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F6FC"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCE4E4"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="12"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="5" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="6" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  function montarXlsx(planilhas) {
    const nomeAba = (n) => xmlEsc(String(n).replace(/[\[\]:*?/\\]/g, " ").slice(0, 31));
    const cab = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const enc = new TextEncoder();
    const arq = (nome, texto) => ({ nome, dados: enc.encode(texto) });
    return montarZip([
      arq("[Content_Types].xml", `${cab}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${planilhas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
      arq("_rels/.rels", `${cab}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
      arq("xl/workbook.xml", `${cab}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${planilhas.map((pl, i) => `<sheet name="${nomeAba(pl.aba)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><definedNames>${planilhas.map((pl, i) => `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${nomeAba(pl.aba)}'!$4:$4</definedName>`).join("")}</definedNames></workbook>`),
      arq("xl/_rels/workbook.xml.rels", `${cab}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${planilhas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${planilhas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
      arq("xl/styles.xml", ESTILOS_XML),
      ...planilhas.map((pl, i) => arq(`xl/worksheets/sheet${i + 1}.xml`, planilhaXml(pl))),
    ]);
  }

  const mascaraCnpj = (v) => {
    const d = String(v || "").replace(/\D/g, "");
    return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : String(v || "");
  };
  const hoje = () => new Date().toLocaleDateString("pt-BR");

  const brutas = [];
  const conteudo = [];
  const resumo = [];
  const codificar = new TextEncoder();
  let erro = null;
  window.__mrParar = false;
  console.log("Para parar a qualquer momento: window.__mrParar = true");
  try {
    for (let i = 0; i < ids.length && !window.__mrParar; i++) {
      const id = ids[i];
      try {
        const regras = await regrasDaEmpresa(id);
        brutas.push(...regras);
        const nome = regras[0] && regras[0].parceiro ? regras[0].parceiro.parRazaosocial : "";
        console.log(`[${i + 1}/${ids.length}] empresa ${id} ${nome}: ${regras.length} regras`);
        if (regras.length) {
          const base = nomeBase(nome, id);
          const cnpj = mascaraCnpj(regras[0].parceiro && regras[0].parceiro.parCnpjcpf);
          conteudo.push({ nome: `${base}/${base}.xlsx`, dados: montarXlsx([{
            aba: "Regras", titulo: nome || `Empresa ${id}`,
            subtitulo: `CNPJ ${cnpj}  |  ${regras.length} regras  |  baixado em ${hoje()}`,
            colunas: COLUNAS_REGRAS, linhas: regras.map(linhaRegra),
          }]) });
        }
        resumo.push({ ...achatarObj(empresaPorId.get(String(id)) || { id }, "", {}), __qtd: regras.length, __pasta: regras.length ? nomeBase(nome, id) : "" });
      } catch (e) {
        if (e.fatal) throw e;
        console.warn(`[${i + 1}/${ids.length}] empresa ${id}: ${e.message} (seguindo para a próxima)`);
      }
      await sleep(DELAY_MS);
    }
  } catch (e) {
    erro = e;
    console.error(e.message);
  }

  // ---- 4. salva os arquivos (mesmo se parou no meio) ----
  if (!brutas.length) { console.warn("Nenhuma regra baixada."); return; }
  const enxuto = JSON.stringify(brutas, (k, v) => (k === "parceiro" && v ? { id: v.id, parCnpjcpf: v.parCnpjcpf, parRazaosocial: v.parRazaosocial } : v));
  conteudo.push({ nome: "todas-as-regras.json", dados: codificar.encode(enxuto) });
  if (resumo.length) {
    const chaves = [...new Set(resumo.flatMap((o) => Object.keys(o)))].filter((k) => !k.startsWith("__"));
    const chaveCriador = chaves.find((k) => /(creat|criad|usuario|user|respons)/i.test(k));
    const dados = (k) => (o) => (o[k] === undefined ? "" : o[k]);
    const colunasResumo = [
      { titulo: "ID", tipo: "centro", get: (o) => (o.id === "" || isNaN(o.id) ? o.id : Number(o.id)) },
      { titulo: "CNPJ", tipo: "centro", get: (o) => mascaraCnpj(o.parCnpjcpf) },
      { titulo: "Razão social", tipo: "texto", get: dados("parRazaosocial") },
      { titulo: "Nome fantasia", tipo: "texto", get: dados("parDescricao") },
      { titulo: "Cidade", tipo: "texto", get: dados("cidade") },
      { titulo: "UF", tipo: "centro", get: dados("estado") },
      { titulo: "Situação", tipo: "centro", get: dados("status") },
      { titulo: "Cadastro na plataforma", tipo: "data", get: (o) => serialData(o.parDatacadastro) },
      ...(chaveCriador ? [{ titulo: "Criado por", tipo: "texto", get: dados(chaveCriador) }] : []),
      { titulo: "Qtd. de regras", tipo: "centro", get: (o) => o.__qtd },
      { titulo: "Pasta", tipo: "texto", get: (o) => o.__pasta },
    ];
    const todosCampos = chaves.map((k) => ({ titulo: k, tipo: "texto", max: 40 }));
    conteudo.push({ nome: "_empresas.xlsx", dados: montarXlsx([
      { aba: "Empresas", titulo: "Empresas e quantidade de regras", subtitulo: `${resumo.length} empresas  |  baixado em ${hoje()}`,
        colunas: colunasResumo.map(({ titulo, tipo }) => ({ titulo, tipo })), linhas: resumo.map((o) => colunasResumo.map((c) => c.get(o))) },
      { aba: "Todos os campos", titulo: "Todos os campos que o sistema informa de cada empresa", subtitulo: "Use esta aba para procurar informações extras (ex.: quem criou a empresa)",
        colunas: todosCampos, linhas: resumo.map((o) => chaves.map((k) => (o[k] === undefined ? "" : o[k]))) },
    ]) });
  }
  const data = new Date().toISOString().slice(0, 10);
  baixar(`regras-mister-${data}.zip`, montarZip(conteudo), "application/zip");
  const empresas = new Set(brutas.map((r) => r.parceiro && r.parceiro.id)).size;
  console.log(`%cPronto: ${brutas.length} regras de ${empresas} empresas, numa pasta por empresa dentro de regras-mister-${data}.zip.${erro ? " (INCOMPLETO: parou por erro)" : ""}`, "font-weight:bold");
})();
