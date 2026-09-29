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
  let ids = [];
  const resposta = prompt("IDs das empresas separados por vírgula (ex.: 9,12,15).\nDeixe vazio para tentar buscar todas.\nDica: teste primeiro só com o 9.", "9");
  if (resposta === null) return;
  if (resposta.trim()) {
    ids = resposta.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    for (const path of ["/parceiros?size=1000&sort=id,asc", "/parceiros?size=1000", "/parceiros"]) {
      try {
        const { data } = await get(path);
        if (Array.isArray(data) && data.length && data[0].parCnpjcpf) {
          ids = data.map((p) => String(p.id));
          console.log(`Lista de empresas obtida em ${path}: ${ids.length} empresas.`);
          break;
        }
      } catch (e) { if (e.fatal) throw e; }
    }
    if (!ids.length) {
      console.error("Não consegui listar as empresas sozinho. Rode de novo e informe os IDs.");
      return;
    }
  }

  // ---- 3. baixa as regras de cada empresa ----
  async function paginar(id, size, parouCurto) {
    const todas = [], vistos = new Set();
    let total = null;
    for (let page = 0; ; page++) {
      const { data, total: t } = await get(`/regras?page=${page}&size=${size}&parceiroId.equals=${id}&sort=id,asc`);
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

  async function regrasDaEmpresa(id) {
    let res = await paginar(id, PAGE_SIZE, true);
    // se o servidor limitou o tamanho da página, refaz de 20 em 20
    if ((res.total !== null && res.todas.length < res.total) || (res.total === null && res.todas.length === 20)) {
      res = await paginar(id, 20, false);
    }
    if (res.total !== null && res.todas.length !== res.total) {
      console.warn(`  Atenção: empresa ${id} veio com ${res.todas.length} de ${res.total} regras.`);
    }
    return res.todas;
  }

  const s = (v) => (v === null || v === undefined ? "" : String(v));
  function achatar(r) {
    const ag = r.agenciabancaria || {};
    const cb = ag.conta || {};
    const c = r.conta || {};
    const p = r.parceiro || {};
    return {
      parceiroId: s(p.id), cnpj: s(p.parCnpjcpf), razaoSocial: s(p.parRazaosocial),
      regraId: s(r.id), descricao: s(r.regDescricao), historico: s(r.regHistorico),
      dataCadastro: s(r.dataCadastro), dc: r.debito ? "D" : "C", tipoRegra: s(r.tipoRegra),
      historicoDoExtrato: s(r.manterHistorico), todos: s(r.regTodos), aplicacao: s(r.aplicacao),
      contaCodigo: s(c.conConta), contaClassificacao: s(c.conClassificacao), contaDescricao: s(c.conDescricao),
      banco: s(ag.banco && ag.banco.banDescricao), codigoBanco: s(ag.banCodigobancario),
      agencia: s(ag.ageAgencia), numeroConta: s(ag.ageNumero), digito: s(ag.ageDigito),
      descricaoAgencia: s(ag.ageDescricao), tipoAgencia: s(ag.tipoAgencia),
      contaBancoCodigo: s(cb.conConta), contaBancoClassificacao: s(cb.conClassificacao),
    };
  }

  function baixar(nome, conteudo, tipo) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const brutas = [];
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
  const linhas = brutas.map(achatar);
  const colunas = Object.keys(linhas[0]);
  const aspas = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = "﻿" + [colunas.join(";"), ...linhas.map((l) => colunas.map((c) => aspas(l[c])).join(";"))].join("\r\n");
  const enxuto = JSON.stringify(brutas, (k, v) => (k === "parceiro" && v ? { id: v.id, parCnpjcpf: v.parCnpjcpf, parRazaosocial: v.parRazaosocial } : v));
  const data = new Date().toISOString().slice(0, 10);
  baixar(`regras-mister-${data}.csv`, csv, "text/csv;charset=utf-8");
  baixar(`regras-mister-${data}.json`, enxuto, "application/json");
  console.log(`%cPronto: ${brutas.length} regras de ${new Set(linhas.map((l) => l.parceiroId)).size} empresas.${erro ? " (INCOMPLETO: parou por erro)" : ""}`, "font-weight:bold");
})();
