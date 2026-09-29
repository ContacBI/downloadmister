/* Leitores dos extratos de aplicações financeiras -- recebem o TEXTO do PDF (itens do pdf.js unidos
   por espaço, todas as páginas) e devolvem um "extrato normalizado":
   {
     id, instituicao, produto, produtoChave, mes:"YYYY-MM", agencia, conta,
     saldoInicial, saldoFinal, aplicacoes, resgates (BRUTO, o que sai do saldo), impostos (retidos nos resgates),
     rendimento (bruto), valorBase?, movimentos:[{data:"YYYY-MM-DD", tipo, valor, impostos?, liquido?, rend?}],
     checks:[{nome, ok, detalhe}]
   }
   Equação de saldo (igual em todos): saldoFinal = saldoInicial + aplicacoes - resgates + rendimento.
   Formatos: Caixa "Extrato Fundo de Investimento" (FIC), Caixa "Informativo Mensal CDB Flex", Bradesco "Extrato Unificado", Banco do Brasil (Rende Fácil, Fundos mensal, CDB/Reaplic), Santander poupança.
   Funciona no navegador (window.AplicParsers) e no Node (module.exports) -- o Node só serve pra testar. */
(function (root) {
  "use strict";

  var MESES = { JANEIRO: 1, FEVEREIRO: 2, MARCO: 3, "MARÇO": 3, ABRIL: 4, MAIO: 5, JUNHO: 6, JULHO: 7, AGOSTO: 8, SETEMBRO: 9, OUTUBRO: 10, NOVEMBRO: 11, DEZEMBRO: 12 };
  var R = /[\d]{1,3}(?:\.\d{3})*,\d{2}/; // valor BR
  function r2(v) { return Math.round((v || 0) * 100) / 100; }
  function nBR(s) { return parseFloat(String(s).replace(/[^\d,]/g, "").replace(",", ".")) || 0; }
  function pad(n) { return String(n).length < 2 ? "0" + n : String(n); }
  function isoBR(d) { var m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(d || ""); return m ? m[3] + "-" + m[2] + "-" + m[1] : null; }
  function slug(t) { return String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
  function prim(t, re) { var m = re.exec(t); return m ? m : null; }
  function chk(nome, esperado, encontrado, tol, aviso) {
    var ok = Math.abs(esperado - encontrado) <= (tol || 0.011);
    return { nome: nome, ok: ok, aviso: !!aviso, detalhe: ok ? "" : "esperado " + fmt(esperado) + " · encontrado " + fmt(encontrado) + " · diferença " + fmt(encontrado - esperado) };
  }
  function fmt(v) { return (v < 0 ? "-" : "") + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "."). replace(/\.(\d{2})$/, ",$1"); }

  /* ------------------------------------------------------------------ Caixa: fundo de investimento (FIC) */
  function caixaFundo(t) {
    var fundo = (prim(t, /Emiss[ãa]o\s+\d{2}\/\d{2}\/\d{4}\s+Fundo\s+(.+?)\s+CNPJ do Fundo/) || [])[1];
    var cnpjFundo = (prim(t, /CNPJ do Fundo\s+([\d./-]+)/) || [])[1] || "";
    var ag = prim(t, /Nome da Ag[êe]ncia\s+(.+?)\s+C[óo]digo\s+(\d+)/);
    var conta = (prim(t, /Conta Corrente\s+([\d.\-]+)/) || [])[1] || "";
    var my = prim(t, /M[êe]s\/Ano\s+(\d{2})\/(\d{4})/);
    if (!fundo || !my) return null;
    var ano = +my[2], mes = +my[1];
    var iR = t.indexOf("Resumo da Movimenta"), iM = t.indexOf("Movimentação Detalhada");
    if (iM < 0) iM = t.search(/Movimenta..o Detalhada/);
    var iT = t.indexOf("Dados de Tributa");
    var resumo = t.slice(iR, iM > 0 ? iM : undefined);
    function v(label) {
      var m = new RegExp(label + "\\*?\\s+(" + R.source + ")([CD])?").exec(resumo);
      return m ? nBR(m[1]) : 0;
    }
    var saldoInicial = v("Saldo Anterior"), aplic = v("Aplica[çc][õo]es"), resg = v("Resgates"), rend = v("Rendimento Bruto no M[êe]s"),
      irrf = v("IRRF"), iof = v("IOF"), saldoFinal = v("Saldo Bruto");
    var seg = t.slice(iM, iT > iM ? iT : undefined);
    var movs = [], re = /(\d{2}) \/ (\d{2}) ([A-ZÇÃÕ.]+) (\d{1,3}(?:\.\d{3})*,\d{2}) ?([CD]) ([\d.]+,\d{6})(?: IRRF (\d{1,3}(?:\.\d{3})*,\d{2}) ?[CD]? IOF (\d{1,3}(?:\.\d{3})*,\d{2}))?/g, m;
    var somaC = 0, somaD = 0;
    while ((m = re.exec(seg))) {
      var val = nBR(m[4]), imp = (m[7] ? nBR(m[7]) : 0) + (m[8] ? nBR(m[8]) : 0);
      if (m[5] === "C") somaC += val; else somaD += val;
      movs.push({ data: ano + "-" + m[2] + "-" + m[1], tipo: m[3], valor: m[5] === "C" ? val : -val, impostos: r2(imp), irrf: m[7] ? nBR(m[7]) : 0, iof: m[8] ? nBR(m[8]) : 0, liquido: val });
    }
    var resgBruto = r2(resg + irrf + iof);
    var checks = [
      chk("Saldo anterior + aplicações − resgates + rendimento − impostos = saldo final", saldoFinal, r2(saldoInicial + aplic - resg + rend - irrf - iof)),
      chk("Movimentação detalhada: créditos = aplicações do resumo", aplic, r2(somaC), 0.011, true),
      chk("Movimentação detalhada: débitos = resgates do resumo", resg, r2(somaD), 0.011, true),
    ];
    return {
      instituicao: "Caixa", produto: fundo.replace(/\s+/g, " "), produtoChave: "caixa-fundo:" + cnpjFundo.replace(/\D/g, ""),
      mes: ano + "-" + pad(mes), agencia: ag ? ag[2] : "", agenciaNome: ag ? ag[1] : "", conta: conta,
      saldoInicial: saldoInicial, saldoFinal: saldoFinal, aplicacoes: aplic, resgates: resgBruto, impostos: r2(irrf + iof), rendimento: rend,
      movimentos: movs, checks: checks,
    };
  }

  /* ------------------------------------------------------------------ Caixa: CDB Flex (informativo mensal) */
  function caixaCdb(t) {
    var mm = /([A-ZÇ]{4,9}) ?\/ ?(\d{4})/.exec(t.slice(t.indexOf("INFORMATIVO")));
    if (!mm || !MESES[mm[1]]) return null;
    var mes = MESES[mm[1]], ano = +mm[2];
    var conta = (prim(t, /Conta\s+(\d{4} \/ \d{4} \/ [\d\s-]+?)\s+(?:Folha|M[êe]s)/) || [])[1] || (prim(t, /Conta\s+(\d{4} ?\/ ?\d{4} ?\/ ?[\d -]+)/) || [])[1] || "";
    var ag = (prim(t, /Ag[êe]ncia\s+(?:Conta\s+Folha\s+M[êe]s\s+)?(\d{4})/) || prim(t, /Conta\s+(\d{4}) ?[.\/]/) || [])[1] || "";
    var nota = prim(t, /(\d{8} \d{6}) N[ºo] Nota/) || prim(t, /N[ºo]\.? Nota\s+(\d{8} \d{6})/);
    var notaTxt = nota ? nota[1].replace(" ", "-") : "";
    var base, rendBruto, prev, rendLiq, saldoFinal, saldoInicial;
    var five = new RegExp("(" + R.source + ") (" + R.source + ") (" + R.source + ") (" + R.source + ") (" + R.source + ") T ?O ?T ?A ?L").exec(t);
    if (five) { // layout A: valores antes do rótulo
      base = nBR(five[1]); rendBruto = nBR(five[2]); prev = nBR(five[3]); rendLiq = nBR(five[4]); saldoFinal = nBR(five[5]);
      var q = new RegExp("Rend Liquido Acum (" + R.source + ") (" + R.source + ") (" + R.source + ") (" + R.source + ") %Rend").exec(t);
      saldoInicial = q ? nBR(q[4]) : NaN;
    } else { // layout B: "rótulo valor"
      function lab(re) { var m = re.exec(t); return m ? nBR(m[1]) : NaN; }
      function labi(src) { return lab(new RegExp(src, "i")); }
      base = labi("Valor Base em \\d{2}/\\d{2}/\\d{4} (" + R.source + ")");
      rendBruto = labi("Rend\\.? Bruto Acumulado (" + R.source + ")");
      prev = labi("Pr(?:ev|ov)\\.? IR \\+ IOF(?: Acumulado)? (" + R.source + ")");
      rendLiq = labi("Rend\\.? L[ií]quido Acumulado (" + R.source + ")");
      saldoFinal = labi("Saldo L[ií]quido em \\d{2}/\\d{2}/\\d{4} (" + R.source + ")");
      var s2 = new RegExp("Saldo em \\d{2}/\\d{2}/\\d{4} (" + R.source + ")", "g"), a = s2.exec(t);
      saldoInicial = a ? nBR(a[1]) : NaN;
    }
    if (isNaN(saldoFinal) || isNaN(base)) return null;
    var checks = [chk("Valor base + rendimento bruto − provisão IR/IOF = saldo líquido", saldoFinal, r2(base + rendBruto - prev))];
    return {
      instituicao: "Caixa", produto: "CDB Flex Empresarial" + (notaTxt ? " (nota " + notaTxt + ")" : ""),
      produtoChave: "caixa-cdb:" + (notaTxt || "x"), mes: ano + "-" + pad(mes), agencia: ag, conta: conta,
      saldoInicial: isNaN(saldoInicial) ? null : saldoInicial, saldoFinal: saldoFinal,
      // o informativo não traz aplicações/resgates: o app deriva pela variação do valor base entre meses
      aplicacoes: 0, resgates: 0, impostos: 0, rendimento: null, valorBase: base, rendBrutoAcum: rendBruto, provisao: prev,
      movimentos: [], checks: checks,
    };
  }

  /* Renda Bruta (B) | Renda Tributável (R) | IOF (I) | IRRF (F): o extrato omite as colunas zeradas. Regras: R = B − I; I + F = imposto
     retirado (atualizado − líquido); IRRF só existe sobre a Renda Tributável (F ≈ 22,5% de R). Testa em quais colunas os valores cabem. */
  function dividirImposto(mid, T) {
    if (T < 0.005) return { iof: 0, irrf: 0 };
    var n = mid.length, achado = null;
    // 1ª passada: R = B − I exato no centavo; 2ª: com 1 centavo de folga (arredondamento do banco)
    [0.005, 0.011].forEach(function (tolR) {
      if (achado || n > 4) return;
      (function pick(ini, esc) {
        if (achado) return;
        if (esc.length === n) {
          var v = [0, 0, 0, 0]; esc.forEach(function (pos, k) { v[pos] = mid[k]; });
          var B = v[0], Rt = v[1], I = v[2], F = v[3], temR = esc.indexOf(1) >= 0;
          if (Math.abs(I + F - T) > 0.011) return;
          if (temR && Math.abs(Rt - (B - I)) > tolR) return;
          if (F > 0 && (!temR || Math.abs(F - 0.225 * Rt) > 0.011)) return;
          achado = { iof: r2(I), irrf: r2(F) };
          return;
        }
        for (var i = ini; i < 4; i++) pick(i + 1, esc.concat(i));
      })(0, []);
    });
    return achado || { iof: 0, irrf: r2(T) };
  }

  /* ------------------------------------------------------------------ Bradesco: Extrato Unificado (investimentos) */
  function bradesco(t) {
    var per = prim(t, /Per[íi]odo\s+(\d{2})\/(\d{2})\/(\d{4}) a (\d{2})\/(\d{2})\/(\d{4})/);
    if (!per) return null;
    var mes = per[6] + "-" + per[5];
    var agencia = (prim(t, /Ag[êe]ncia\s+(\d{4} - \d)/) || [])[1] || "";
    var conta = (prim(t, /Conta\s+(\d{3,9} - \d)\s+Telefone/) || [])[1] || "";
    // resumo do topo
    var iRes = t.indexOf("Resumo Financeiro"), iLim = t.search(/Limite Cr[ée]dito|Conta-Corrente Demonstrativo/);
    var topo = iRes >= 0 ? t.slice(iRes, iLim > iRes ? iLim : iRes + 900) : "";
    var numsTopo = (topo.match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || []).map(nBR);
    var tg = new RegExp("Total Geral (" + R.source + ") (" + R.source + ")").exec(t);
    // seções de produto
    var reSec = /((?:CDB|Invest F[áa]cil|Fundos?|LCI|LCA|Poupan[çc]a|[A-ZÀ-Úa-zà-ú]+)(?: [A-ZÀ-Úa-zà-ú]+){0,2} Bradesco) L E G/g;
    var secs = [], m;
    while ((m = reSec.exec(t))) secs.push({ nome: m[1], ini: m.index + m[0].length });
    var out = [];
    secs.forEach(function (s, i) {
      var fim = t.indexOf("Total de Rendimento Tribut", s.ini);
      var corpo = t.slice(s.ini, fim > 0 ? fim : (secs[i + 1] ? secs[i + 1].ini : undefined));
      corpo = corpo.replace(/^.*?D[ée]bito\/Cr[ée]dito\)\s*/, ""); // tira o cabeçalho da tabela
      var toks = corpo.split(/\s+/), rows = [], cur = null;
      toks.forEach(function (tk) {
        if (/^0[1-5]$/.test(tk)) { cur = { leg: tk, datas: [], vals: [] }; rows.push(cur); }
        else if (!cur) return;
        else if (/^\d{2}\/\d{2}\/\d{4}$/.test(tk)) cur.datas.push(tk);
        else if (/^\d{1,3}(?:\.\d{3})*,\d{2}-?$/.test(tk)) cur.vals.push({ v: nBR(tk), neg: /-$/.test(tk) });
      });
      // "01 05 a b c d" (saldo anterior e atual impressos juntos)
      for (var k = 0; k < rows.length - 1; k++) {
        if (rows[k].leg === "01" && rows[k + 1].leg === "05" && !rows[k].vals.length && rows[k + 1].vals.length === 4) {
          rows[k].vals = rows[k + 1].vals.slice(0, 2); rows[k + 1].vals = rows[k + 1].vals.slice(2);
        }
      }
      // "01 03 05 <datas> <todos os valores>" impressos juntos (resgate parcial, sem aplicação no mês): os valores vêm todos na
      // linha do 05, na ordem [saldo ant. (2)] [resgate: principal, atualizado (2)] [saldo atual (2)] [renda bruta, tributável, IOF?, IRRF, líquido].
      for (var k2 = 0; k2 < rows.length - 2; k2++) {
        var a1 = rows[k2], a2 = rows[k2 + 1], a3 = rows[k2 + 2];
        if (a1.leg === "01" && !a1.vals.length && /^0[34]$/.test(a2.leg) && !a2.vals.length && a3.leg === "05" && a3.vals.length >= 7) {
          var V = a3.vals;
          a1.vals = V.slice(0, 2);
          a2.vals = V.slice(2, 4).concat(V.slice(6)); a2.datas = a3.datas;
          a3.vals = V.slice(4, 6); a3.datas = [];
        }
      }
      var ini = rows.filter(function (r) { return r.leg === "01"; })[0], fimR = rows.filter(function (r) { return r.leg === "05"; })[0];
      if (!ini || !fimR) return;
      var aplic = 0, aplicMov = [], resgB = 0, resgP = 0, imp = 0, liqTot = 0, resgMov = [], iofTot = 0;
      rows.forEach(function (r) {
        var data = isoBR(r.datas[0]);
        if (r.leg === "02" && r.vals.length) {
          aplic += r.vals[0].v; aplicMov.push({ data: data, tipo: "APLICACAO", valor: r.vals[0].v });
        } else if ((r.leg === "03" || r.leg === "04") && r.vals.length >= 3) {
          var princ = r.vals[0].v, atual = r.vals[1].v, liq = r.vals[r.vals.length - 1].v;
          // colunas do extrato: Renda Bruta | Renda Tributável | IOF | IRRF -- só saem as que têm valor, então a posição não diz qual é qual.
          // Descobre pela aritmética (ver dividirImposto).
          var totImp = r2(atual - liq), mid = r.vals.slice(2, -1).map(function (x) { return x.v; });
          var iofR = dividirImposto(mid, totImp).iof;
          var irrfR = r2(totImp - iofR);
          resgB += atual; resgP += princ; imp += totImp; liqTot += liq; iofTot += iofR;
          resgMov.push({ data: data, tipo: r.leg === "04" ? "RESGATE TOTAL" : "RESGATE", valor: -atual, impostos: totImp, irrf: irrfR, iof: iofR, liquido: liq, principal: princ, rend: r2(atual - princ) });
        }
      });
      var sIni = ini.vals[1] ? ini.vals[1].v : ini.vals[0].v, sFim = fimR.vals[1] ? fimR.vals[1].v : fimR.vals[0].v;
      var pIni = ini.vals[0].v, pFim = fimR.vals[0].v;
      var rend = r2(sFim - sIni - aplic + resgB);
      var checks = [
        chk("Principal: saldo anterior + aplicações − principal resgatado = saldo atual", pFim, r2(pIni + aplic - resgP)),
        chk("Rendimento dos resgates (bruto − principal) fecha com o líquido creditado em conta", r2(resgB - imp), r2(liqTot)),
      ];
      // o próprio extrato imprime "Total de Imposto de Renda" (= IRRF, sem o IOF) -- confere com o IRRF separado dos resgates
      var totIR = new RegExp("Total de Imposto de Renda (" + R.source + ")").exec(t.slice(fim > 0 ? fim : s.ini, (fim > 0 ? fim : s.ini) + 200));
      if (totIR) checks.push(chk("IRRF dos resgates fecha com o 'Total de Imposto de Renda' do extrato", nBR(totIR[1]), r2(imp - iofTot)));
      var noResumo = numsTopo.indexOf(sIni) >= 0 && numsTopo.indexOf(sFim) >= 0;
      checks.push({ nome: "Saldos do detalhe aparecem no resumo do topo do extrato", ok: noResumo, detalhe: noResumo ? "" : "saldo " + fmt(sIni) + " / " + fmt(sFim) + " não encontrado no resumo" });
      out.push({
        instituicao: "Bradesco", produto: s.nome.replace(/\s+Bradesco$/, "").replace(/^Investimentos\s+/, ""), produtoChave: "bradesco:" + slug(s.nome.replace(/^Investimentos\s+/, "")) + ":" + slug(conta),
        mes: mes, agencia: agencia, conta: conta, saldoInicial: sIni, saldoFinal: sFim, aplicacoes: r2(aplic), resgates: r2(resgB), impostos: r2(imp), iof: r2(iofTot), irrf: r2(imp - iofTot), rendimento: rend,
        principalInicial: pIni, principalFinal: pFim, movimentos: aplicMov.concat(resgMov).sort(function (a, b) { return a.data < b.data ? -1 : a.data > b.data ? 1 : 0; }), checks: checks,
      });
    });
    // Fundo "SIMPLES AUTOMATICO" (Investimentos Fundos - Posição Consolidada): não tem a tabela L E G; só saldo anterior, rendimento e saldo atual (mais
    // aplicações/resgates/IR quando houver). Sem ele o Total Geral do resumo não fecha (o saldo do fundo ficaria "escondido" na conta-corrente).
    var mFun = /Fundos?\s+Posi\S*\s+Consolidada/.exec(t);
    if (mFun) {
      var blF = t.slice(mFun.index, mFun.index + 5000), cortaF = blF.search(/(?:CDB|Invest F[áa]cil)\s+Bradesco\s+L E G/); if (cortaF > 0) blF = blF.slice(0, cortaF);
      function valF(rot) { var mv = new RegExp(rot + "[^\\d\\n]{0,40}?(" + R.source + ")").exec(blF); return mv ? nBR(mv[1]) : null; }
      var fIni = valF("Saldo Anterior Bruto"), fFim = valF("\\(=\\)\\s*Saldo Atual Bruto"), fRend = valF("Rendimento Bruto no Per\\S*"), fApl = valF("\\(\\+\\)\\s*Aplica\\S*"), fRes = valF("\\(-\\)\\s*Resgate\\S*"), fIR = valF("\\(-\\)\\s*(?:Antecipa\\S*\\s+de\\s+IR|IR|Imposto de Renda|Come[- ]?cotas)\\S*"); // maio/novembro: "(-)Antecipação de IR" (come-cotas)
      if (fIni !== null && fFim !== null) {
        var nomeF = ((/CNPJ:\s*[\d.\/-]+\s+([A-ZÀ-Ú][A-ZÀ-Ú0-9 .\/-]{4,90}?)\s+CNPJ:/.exec(blF) || [])[1] || "Fundo Simples Automático").trim();
        var aplF = fApl || 0, resF = fRes || 0, irF = fIR || 0, rendF = fRend || 0;
        out.push({
          instituicao: "Bradesco", produto: "Fundo Simples Automático", produtoChave: "bradesco:fundo-simples-automatico:" + slug(conta),
          mes: mes, agencia: agencia, conta: conta, saldoInicial: fIni, saldoFinal: fFim, aplicacoes: r2(aplF), resgates: r2(resF), impostos: r2(irF), iof: 0, irrf: r2(irF), rendimento: rendF,
          nomeFundo: nomeF, movimentos: [],
          checks: [
            chk("Saldo anterior + aplicações − resgates + rendimento − IR = saldo atual", fFim, r2(fIni + aplF - resF + rendF - irF)),
            { nome: "Saldos do fundo aparecem no resumo do topo do extrato", ok: numsTopo.indexOf(fIni) >= 0 && numsTopo.indexOf(fFim) >= 0, detalhe: "saldo " + fmt(fIni) + " / " + fmt(fFim) + " não encontrado no resumo" },
          ],
        });
      }
    }
    // Total Geral do resumo = conta corrente + investimentos -> confere a soma dos produtos lidos
    if (tg && out.length) {
      var somaIni = r2(out.reduce(function (s, e) { return s + e.saldoInicial; }, 0)), somaFim = r2(out.reduce(function (s, e) { return s + e.saldoFinal; }, 0));
      var ccIni = r2(nBR(tg[1]) - somaIni), ccFim = r2(nBR(tg[2]) - somaFim);
      var okCc = numsTopo.indexOf(ccIni) >= 0 && numsTopo.indexOf(ccFim) >= 0;
      out.forEach(function (e) {
        e.checks.push({ nome: "Total Geral − investimentos = saldo em conta-corrente (" + fmt(ccIni) + " → " + fmt(ccFim) + ") presente no resumo", ok: okCc, detalhe: okCc ? "" : "os produtos lidos não fecham com o Total Geral do resumo" });
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ Banco do Brasil e Santander (poupança)
     Os PDFs do BB às vezes vêm só como IMAGEM (print do portal): o texto então vem do OCR, que troca acento ("mês" -> "més"), "ç" por "g", "," por "." e,
     de vez em quando, um dígito. Por isso os leitores abaixo ignoram acento, aceitam "R$"/"RS", "," ou "." como separador de centavos e SEMPRE fecham
     contas (saldo, somas do resumo x lista, capital+rendimento-IR-IOF = líquido de cada resgate) -- um dígito errado do OCR aparece como aviso, não passa batido. */
  var MN = "(\\d{1,3}(?:\\.\\d{3})*[,.]\\d{2}(?!\\d)|\\d+[,.]\\d{2}(?!\\d))"; // (?!\d): "12.463.557 41" (OCR sem a vírgula) não vira "12.463,55"
  function nOcr(s) {
    var d = String(s).replace(/[^\d.,]/g, ""), i = Math.max(d.lastIndexOf(","), d.lastIndexOf("."));
    if (i < 0) return parseFloat(d) || 0;
    return parseFloat(d.slice(0, i).replace(/[.,]/g, "") + "." + d.slice(i + 1)) || 0;
  }
  function semAcento(t) { return String(t).normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  var MES_NOME = { JANEIRO: 1, FEVEREIRO: 2, MARCO: 3, ABRIL: 4, MAIO: 5, JUNHO: 6, JULHO: 7, AGOSTO: 8, SETEMBRO: 9, OUTUBRO: 10, NOVEMBRO: 11, DEZEMBRO: 12 };
  function mesDe(nome, ano) { var n = MES_NOME[semAcento(nome).toUpperCase()]; return n ? ano + "-" + pad(n) : null; }
  function soma(a, f) { return r2(a.reduce(function (s, x) { return s + f(x); }, 0)); }

  /* BB Rende Fácil: resumo do mês + histórico (Capital | Rendimento | IR | IOF | Valor líquido) */
  function bbRendeFacil(t) {
    var p = semAcento(t).replace(/\s+/g, " ");
    var mm = /Resumo do m.s\s*-\s*([A-Za-z]+)\s*\/\s*(\d{4})/.exec(p); if (!mm) return null;
    var mes = mesDe(mm[1], mm[2]); if (!mes) return null;
    var ag = /Agencia\s+(\d{4}-\d)\s+Conta\s+([\d.]+-[\dXx])/.exec(p) || /Agencia\s+Conta\s+(\d{4}-\d)\s+([\d.]+-[\dXx])/.exec(p) || [];
    var agencia = ag[1] || "", conta = String(ag[2] || "").toUpperCase();
    var saldos = [], reS = new RegExp("Saldo bruto em\\s+\\d{2}/\\d{2}/\\d{4}\\s*:?\\s*R[$S]?\\s?" + MN, "gi"), s;
    while ((s = reS.exec(p))) saldos.push(nOcr(s[1]));
    function rot(re) { var m = new RegExp(re + "\\s*:?\\s*R[$S]?\\s?" + MN, "i").exec(p); return m ? nOcr(m[1]) : NaN; }
    var aplic = rot("Aplica\\S*\\s+no\\s+mes"), resgL = rot("Resgates\\s+liquidos\\s+no\\s+mes"), ir = rot("IR\\s+sobre\\s+resgates\\s+no\\s+mes"),
      iof = rot("IOF\\s+sobre\\s+resgates\\s+no\\s+mes"), rend = rot("Rendimentos\\s+no\\s+mes");
    if (saldos.length < 2 || isNaN(aplic) || isNaN(resgL)) return null;
    ir = isNaN(ir) ? 0 : ir; iof = isNaN(iof) ? 0 : iof; rend = isNaN(rend) ? 0 : rend;
    var saldoIni = saldos[0], saldoFin = saldos[saldos.length - 1];
    var reM = new RegExp("(\\d{2})/(\\d{2})/(\\d{4})\\s+(Aplica\\S+|Resgate|Saldo\\s+Anterior|Saldo\\s+Final)\\s+R[$S]?\\s?" + MN + "\\s+R[$S]?\\s?" + MN + "\\s+R[$S]?\\s?" + MN + "\\s+R[$S]?\\s?" + MN + "\\s+R[$S]?\\s?" + MN, "gi"), m;
    var movs = [], anterior = null, ruins = [];
    while ((m = reM.exec(p))) {
      var tipo = m[4].toUpperCase().replace(/\s+/g, " "), cap = nOcr(m[5]), rd = nOcr(m[6]), i2 = nOcr(m[7]), o2 = nOcr(m[8]), liq = nOcr(m[9]), data = m[3] + "-" + m[2] + "-" + m[1];
      if (/SALDO ANTERIOR/.test(tipo)) { anterior = { cap: cap, rend: rd }; continue; }
      if (/SALDO FINAL/.test(tipo)) continue;
      if (/APLICA/.test(tipo)) movs.push({ data: data, tipo: "APLICACAO", valor: cap, principal: cap, liquido: cap, rend: 0, impostos: 0 });
      else {
        if (Math.abs(cap + rd - i2 - o2 - liq) > 0.011) ruins.push(m[1] + "/" + m[2] + " " + fmt(liq));
        movs.push({ data: data, tipo: "RESGATE", valor: r2(cap + rd), principal: cap, liquido: liq, rend: rd, irrf: i2, iof: o2, impostos: r2(i2 + o2) });
      }
    }
    var somaApl = soma(movs.filter(function (x) { return x.tipo === "APLICACAO"; }), function (x) { return x.valor; });
    var somaLiq = soma(movs.filter(function (x) { return x.tipo === "RESGATE"; }), function (x) { return x.liquido; });
    var checks = [
      chk("Saldo inicial + aplicações − resgates (líquidos + IR + IOF) + rendimentos = saldo final", saldoFin, r2(saldoIni + aplic - (resgL + ir + iof) + rend)),
      chk("Histórico: soma das aplicações = resumo do mês", aplic, somaApl, 0.011, true),
      chk("Histórico: soma dos resgates líquidos = resumo do mês", resgL, somaLiq, 0.011, true),
    ];
    if (anterior) checks.push(chk("Saldo anterior (capital + rendimento) = saldo bruto inicial", saldoIni, r2(anterior.cap + anterior.rend), 0.011, true));
    if (ruins.length) checks.push({ nome: "Cada resgate: capital + rendimento − IR − IOF = valor líquido", ok: false, aviso: true, detalhe: "linhas que não fecham (provável erro de leitura do OCR): " + ruins.slice(0, 6).join("; ") });
    return {
      instituicao: "Banco do Brasil", produto: "BB Rende Fácil", produtoChave: "bb-rende-facil:" + String(conta).replace(/\W/g, "").toLowerCase(),
      mes: mes, agencia: agencia, conta: conta, saldoInicial: saldoIni, saldoFinal: saldoFin, aplicacoes: aplic, resgates: r2(resgL + ir + iof), impostos: r2(ir + iof), rendimento: rend,
      movimentos: movs, checks: checks,
    };
  }

  /* BB "Extratos - Investimentos Fundos - Mensal": vários fundos no mesmo PDF; cada um com resumo (saldo anterior, aplicações, resgates, rendimento bruto, IR, IOF) */
  function bbFundos(t) {
    var p = semAcento(t).replace(/\s+/g, " ");
    var mm = /Mes\/ano referencia\s+([A-Za-z]+)\s*\/\s*(\d{4})/.exec(p); if (!mm) return null;
    var mes = mesDe(mm[1], mm[2]); if (!mes) return null;
    var ag = /Agencia\s+(\d{4}-\d)\s+Conta\s+([\d.]+-[\dXx])/.exec(p) || /Agencia\s+Conta\s+(\d{4}-\d)\s+([\d.]+-[\dXx])/.exec(p) || [];
    var agencia = ag[1] || "", conta = String(ag[2] || "").toUpperCase();
    var heads = [], re = /\s-\sCNPJ:\s*([\d.\/-]+)/g, h;
    while ((h = re.exec(p))) {
      var palavras = p.slice(Math.max(0, h.index - 60), h.index).split(" "), nome = [];
      for (var i = palavras.length - 1; i >= 0 && nome.length < 6; i--) { if (/[\d\/:]/.test(palavras[i]) || !palavras[i]) break; nome.unshift(palavras[i]); }
      heads.push({ nome: nome.join(" "), cnpj: h[1], ini: h.index + h[0].length });
    }
    var out = [];
    heads.forEach(function (f, k) {
      var bloco = p.slice(f.ini, k + 1 < heads.length ? heads[k + 1].ini - 80 : undefined);
      var iRes = bloco.search(/Resumo do mes/i), tabela = iRes >= 0 ? bloco.slice(0, iRes) : bloco, resumo = iRes >= 0 ? bloco.slice(iRes) : "";
      function lab(re2) { var m2 = new RegExp(re2 + "\\s*=?\\s*" + MN, "i").exec(resumo); return m2 ? nOcr(m2[1]) : NaN; }
      var ini = lab("SALDO ANTERIOR"), aplic = lab("APLICACOES\\s*\\(\\+\\)"), resg = lab("RESGATES\\s*\\(-\\)"), rendB = lab("RENDIMENTO BRUTO\\s*\\(\\+\\)"),
        ir = lab("IMPOSTO DE RENDA\\s*\\(-\\)"), iof = lab("IOF\\s*\\([-+]\\)"), fin = lab("SALDO ATUAL");
      if (isNaN(fin)) return;
      aplic = isNaN(aplic) ? 0 : aplic; resg = isNaN(resg) ? 0 : resg; rendB = isNaN(rendB) ? 0 : rendB; ir = isNaN(ir) ? 0 : ir; iof = isNaN(iof) ? 0 : iof;
      if (isNaN(ini)) { var t0 = new RegExp("\\d{2}/\\d{2}/\\d{4}\\s+SALDO ANTERIOR\\s+" + MN, "i").exec(tabela); ini = t0 ? nOcr(t0[1]) : r2(fin - aplic + resg - rendB + ir + iof); }
      var movs = [], reM = new RegExp("(\\d{2})/(\\d{2})/(\\d{4})\\s+(APLICA\\w*|RESGATE)\\s+" + MN + "(?:\\s+" + MN + "(?=\\s+[\\d.]+[,.]\\d{6}))?", "gi"), m;
      while ((m = reM.exec(tabela))) {
        var data = m[3] + "-" + m[2] + "-" + m[1], v = nOcr(m[5]), imp = m[6] ? nOcr(m[6]) : 0;
        if (/APLICA/i.test(m[4])) movs.push({ data: data, tipo: "APLICACAO", valor: v, principal: v, liquido: v, rend: 0, impostos: 0 });
        else movs.push({ data: data, tipo: "RESGATE", valor: v, principal: v, liquido: v, rend: 0, irrf: imp, iof: 0, impostos: imp }); // o IR sai das cotas À PARTE: o resgate cai inteiro no banco
      }
      // IR do resumo que não aparece nos resgates = come-cotas (maio/novembro): debitado em cotas, sem linha na movimentação
      var irMov = soma(movs, function (x) { return x.irrf || 0; }), resto = r2(ir - irMov);
      if (resto > 0.005) movs.push({ data: mes + "-" + pad(new Date(+mes.slice(0, 4), +mes.slice(5, 7), 0).getDate()), tipo: "COMECOTAS", valor: -resto, irrf: resto, impostos: resto });
      var checks = [
        chk("Saldo anterior + aplicações − resgates + rendimento bruto − IR − IOF = saldo atual", fin, r2(ini + aplic - resg + rendB - ir - iof)),
        chk("Movimentação: soma das aplicações = resumo", aplic, soma(movs.filter(function (x) { return x.tipo === "APLICACAO"; }), function (x) { return x.valor; }), 0.011, true),
        chk("Movimentação: soma dos resgates = resumo", resg, soma(movs.filter(function (x) { return x.tipo === "RESGATE"; }), function (x) { return x.valor; }), 0.011, true),
      ];
      out.push({
        instituicao: "Banco do Brasil", produto: f.nome || "Fundo BB", produtoChave: "bb-fundo:" + f.cnpj.replace(/\D/g, "") + ":" + String(conta).replace(/\W/g, "").toLowerCase(),
        mes: mes, agencia: agencia, conta: conta, saldoInicial: ini, saldoFinal: fin, aplicacoes: aplic, resgates: r2(resg + ir + iof), impostos: r2(ir + iof), rendimento: rendB,
        movimentos: movs, checks: checks,
      });
    });
    return out;
  }

  /* BB "CDB / RDB e BB Reaplic": saldo = LÍQUIDO PROJETADO da tabela "saldo nos últimos 6 meses" (capital + juros − IR projetado), como o CDB da Caixa.
     Mês sem saldo/movimento: tudo zero. Mês com resgate: "Resgate ... valor capital X valor juros ... valor IR ... valor liquido L" (o líquido cai no banco). */
  function bbCdb(t) {
    var p = semAcento(t).replace(/\s+/g, " ");
    var per = /Periodo\s+(\d{2})\/(\d{2})\/(\d{4})\s+a\s+(\d{2})\/(\d{2})\/(\d{4})/.exec(p); if (!per) return null;
    var ag = /Agencia\s+(\d{4}-\d)\s+Conta\s+([\d.]+-[\dXx])/.exec(p) || /Agencia\s+Conta\s+(\d{4}-\d)\s+([\d.]+-[\dXx])/.exec(p) || [];
    var prod = (/\b(BB CDB DI|BB Reaplic|BB CDB [A-Z0-9 ]{2,12}?)\s+Data\b/.exec(p) || [])[1] || "BB CDB";
    var conta = String(ag[2] || "").toUpperCase(), mes = per[3] + "-" + per[2], base = { instituicao: "Banco do Brasil", produto: prod, produtoChave: "bb-cdb:" + conta.replace(/\W/g, "").toLowerCase(), mes: mes, agencia: ag[1] || "", conta: conta };
    if (/Nao ha sdo\/movto no periodo/i.test(p) && new RegExp("Saldo final\\s+" + MN, "i").test(p)) {
      return Object.assign(base, { saldoInicial: 0, saldoFinal: 0, aplicacoes: 0, resgates: 0, impostos: 0, rendimento: 0, movimentos: [], checks: [chk("Sem saldo nem movimento no período", 0, 0)] });
    }
    var MV = "(\\d+[.,]\\s?\\d{2})"; // valor com espaço depois da vírgula (erro de OCR: "600, 85")
    var iniCap = new RegExp("Saldo anterior\\s+valor capital\\s+" + MN, "i").exec(p), fimCap = new RegExp("Saldo final\\s+valor capital\\s+" + MN, "i").exec(p);
    var reR = new RegExp("(\\d{2})/(\\d{2})\\s+Resgate[^v]*?valor capital\\s+" + MN + "\\s+valor juros ate mes ant\\s+" + MV + "\\s+valor juros no mes\\s+" + MV + "\\s+valor IR\\s+" + MV + "-?\\s+valor liquido\\s+" + MV, "gi"), m, movs = [], capRes = 0;
    while ((m = reR.exec(p))) {
      var cap = nOcr(m[3]), liq = nOcr(m[7]);
      capRes += cap;
      // componentes do resgate no extrato: capital | juros até o mês anterior + juros do mês (= rendimento bruto) | IR | líquido. O banco credita CAPITAL e JUROS LÍQUIDOS em linhas separadas; o IR vira lançamento próprio (IRRF a compensar).
      var jurBruto = r2(nOcr(m[4]) + nOcr(m[5])), irCdb = nOcr(m[6]);
      movs.push({ data: per[6] + "-" + m[2] + "-" + m[1], tipo: "RESGATE", valor: liq, principal: cap, liquido: liq, rend: jurBruto, irrf: irCdb, iof: 0, impostos: irCdb });
      var esperado = r2(cap + nOcr(m[4]) + nOcr(m[5]) - nOcr(m[6]));
      if (Math.abs(esperado - liq) > 0.011) movs[movs.length - 1].aviso = "capital + juros − IR (" + fmt(esperado) + ") ≠ líquido (" + fmt(liq) + ")";
    }
    // tabela dos últimos 6 meses: capital | juros | IR proj. | líquido proj. em cada fim de mês
    var linhas = [], reT = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d+[.,]\s?\d{2})\s+(\d+[.,]\s?\d{2})\s+(\d+[.,]\s?\d{2})\s+(\d+[.,]\s?\d{2})/g, tt;
    while ((tt = reT.exec(p))) linhas.push({ ym: tt[3] + "-" + tt[2], dia: tt[1], liq: nOcr(tt[7]), cap: nOcr(tt[4]) });
    var ant = +mes.slice(5, 7) === 1 ? (+mes.slice(0, 4) - 1) + "-12" : mes.slice(0, 5) + pad(+mes.slice(5, 7) - 1);
    var lIni = linhas.filter(function (x) { return x.ym === ant; }).slice(-1)[0], lFim = linhas.filter(function (x) { return x.ym === mes; }).slice(-1)[0];
    if (!lFim || (!lIni && !iniCap)) return null;
    var ini = lIni ? lIni.liq : 0, fin = lFim.liq, resg = soma(movs, function (x) { return x.principal + x.rend; }), irTot = soma(movs, function (x) { return x.irrf; }), rend = r2(fin - ini + resg); // resgates BRUTOS (capital + juros); o IR sai à parte
    var checks = [];
    if (iniCap && fimCap) checks.push(chk("Capital: saldo anterior − capital resgatado = saldo final", nOcr(fimCap[1]), r2(nOcr(iniCap[1]) - capRes)));
    if (lIni && iniCap) checks.push(chk("Saldo inicial: capital da tabela = saldo anterior do extrato", nOcr(iniCap[1]), lIni.cap, 0.011, true));
    var avisos = movs.filter(function (x) { return x.aviso; });
    if (avisos.length) checks.push({ nome: "Resgate: capital + juros − IR = valor líquido", ok: false, aviso: true, detalhe: avisos.map(function (x) { return x.aviso; }).join("; ") });
    return Object.assign(base, { saldoInicial: ini, saldoFinal: fin, aplicacoes: 0, resgates: resg, impostos: irTot, irrf: irTot, iof: 0, rendimento: rend, movimentos: movs, checks: checks });
  }

  /* Santander — conta poupança (internet banking PJ) */
  function santanderPoupanca(t) {
    var p = semAcento(t).replace(/\s+/g, " ");
    var per = /Periodo\s+(?:\S+\s+){0,4}?(\d{2})\/(\d{2})\/(\d{4})\s+a\s+(\d{2})\/(\d{2})\/(\d{4})/.exec(p); if (!per) return null; // (OCR intercala lixo entre "Período" e as datas)
    var cp = /Conta Poupanca\s+(\d{4})\s+(\d{6,12})/.exec(p) || [], cc = /Agencia\s*:?\s*(\d{4})\s+Conta\s*:?\s*(\d{6,12})/.exec(p) || [];
    var re = new RegExp("Saldo Anterior\\s+" + MN + "\\s+Saldo Atual\\s+" + MN + "\\s+Remunera\\S*\\s+B\\S*\\s+" + MN + "\\s+Juros no Periodo\\s+" + MN + "\\s+Credito no Periodo\\s+" + MN + "\\s+Debito no Periodo\\s+" + MN), m = re.exec(p);
    if (!m) return null;
    var ini = nOcr(m[1]), fin = nOcr(m[2]), rem = nOcr(m[3]), juros = nOcr(m[4]), cred = nOcr(m[5]), deb = nOcr(m[6]);
    var ir = new RegExp("(\\d{2})/(\\d{2})/(\\d{4})\\s+\\d{5}\\s+IMPOSTO DE RENDA\\s+" + MN, "i").exec(p);
    var movs = ir ? [{ data: ir[3] + "-" + ir[2] + "-" + ir[1], tipo: "IRRF", valor: -nOcr(ir[4]), irrf: nOcr(ir[4]), impostos: nOcr(ir[4]) }] : [];
    return {
      instituicao: "Santander", produto: "Poupança", produtoChave: "santander-poupanca:" + (cc[2] || cp[2] || "x"), mes: per[3] + "-" + per[2], agencia: cp[1] || cc[1] || "", conta: cp[2] || cc[2] || "",
      saldoInicial: ini, saldoFinal: fin, aplicacoes: cred, resgates: deb, impostos: deb, rendimento: r2(rem + juros), movimentos: movs,
      checks: [chk("Saldo anterior + remuneração + juros + créditos − débitos = saldo atual", fin, r2(ini + rem + juros + cred - deb))],
    };
  }

  /* ------------------------------------------------------------------ catálogo de modelos */
  var MODELOS = [
    { id: "caixa-fundo", instituicao: "Caixa", nome: "Extrato de fundo de investimento (FIC)", imagem: "/modelos/aplic_caixa_fundo__extrato.png",
      descricao: "Extrato do SIDMF da Caixa (\"Extrato Fundo de Investimento\"): resumo da movimentação (saldo anterior, aplicações, resgates, rendimento bruto, IRRF/IOF, saldo bruto) e a movimentação detalhada por dia.",
      reconhece: function (t) { return /Extrato Fundo de Investimento/.test(t) && /CNPJ do Fundo/.test(t); }, ler: function (t) { var a = caixaFundo(t); return a ? [a] : []; } },
    { id: "caixa-cdb", instituicao: "Caixa", nome: "Informativo mensal CDB Flex Empresarial", imagem: "/modelos/aplic_caixa_cdb__extrato.png",
      descricao: "Informativo mensal do CDB/RDB da Caixa: valor base, rendimento bruto acumulado, provisão de IR/IOF, saldo líquido e saldos dos dois meses. Aplicações/resgates são deduzidos pela variação do valor base entre os meses.",
      reconhece: function (t) { return /INFORMATIVO MENSAL CDB/i.test(t); }, ler: function (t) { var a = caixaCdb(t); return a ? [a] : []; } },
    { id: "bradesco-unificado", instituicao: "Bradesco", produtos: [{ slug: "invest-facil", nome: "Invest Fácil" }, { slug: "cdb", nome: "CDB" }, { slug: "fundo-simples-automatico", nome: "Fundo Simples Automático" }], nome: "Extrato Unificado PJ — investimentos (Invest Fácil, CDB, Fundo Simples Automático)", imagem: "/modelos/aplic_bradesco_unificado__extrato.png",
      descricao: "Extrato Unificado – Pessoa Jurídica do Bradesco: lê o resumo financeiro do topo e, mais abaixo, cada produto (Invest Fácil, CDB...) com saldo anterior/atual, aplicações e resgates. Um PDF gera uma linha por produto.",
      reconhece: function (t) { return /Extrato Unificado/.test(t) && /L E G/.test(t); }, ler: function (t) { return bradesco(t) || []; } },
    { id: "bb-rende-facil", instituicao: "Banco do Brasil", nome: "BB Rende Fácil — extrato mensal", imagem: "/modelos/aplic_bb_rende_facil__extrato.png",
      descricao: "Extrato do BB Rende Fácil (portal BB): resumo do mês (saldo bruto, aplicações, resgates líquidos, IR e IOF sobre resgates, rendimentos) e o histórico de movimentação (capital, rendimento, IR, IOF e valor líquido de cada aplicação/resgate). Aceita o PDF em texto ou impresso como imagem (lido por OCR, com todas as contas conferidas).",
      reconhece: function (t) { var p = semAcento(t); return /RENDE F.CIL/i.test(p) && /Resumo do m.s/i.test(p); }, ler: function (t) { var a = bbRendeFacil(t); return a ? [a] : []; } },
    { id: "bb-fundos-mensal", instituicao: "Banco do Brasil", nome: "BB Investimentos — Fundos (mensal)", imagem: "/modelos/aplic_bb_fundos__extrato.png",
      descricao: "\"Extratos - Investimentos Fundos - Mensal\" do BB: cada fundo (RF Ref DI Plus, RF CP Corporate Ágil...) com movimentação (aplicações/resgates em cotas) e resumo do mês (saldo anterior, aplicações, resgates, rendimento bruto, IR, IOF, saldo atual). Um PDF gera uma aplicação por fundo.",
      reconhece: function (t) { return /Investimentos Fundos\s*-\s*Mensal/i.test(semAcento(t)); }, ler: function (t) { return bbFundos(t) || []; } },
    { id: "bb-cdb-reaplic", instituicao: "Banco do Brasil", nome: "BB CDB / RDB e BB Reaplic", imagem: "/modelos/aplic_bb_cdb__extrato.png",
      descricao: "\"Extratos - CDB / RDB e BB Reaplic\" do BB. Por ora lê o mês sem saldo/movimento (saldo final zerado); meses com movimento entram assim que aparecer um exemplo.",
      reconhece: function (t) { return /CDB\s*\/\s*RDB e BB Reaplic/i.test(semAcento(t)); }, ler: function (t) { var a = bbCdb(t); return a ? [a] : []; } },
    { id: "santander-poupanca", instituicao: "Santander", nome: "Conta poupança (Internet Banking PJ)", imagem: "/modelos/aplic_santander_poupanca__extrato.png",
      descricao: "Extrato da conta poupança do Santander Empresarial: saldo anterior, remuneração básica, juros, créditos, débitos (IR) e saldo atual do período.",
      reconhece: function (t) { var p = semAcento(t); return /Conta Poupan/i.test(p) && /Santander/i.test(p); }, ler: function (t) { var a = santanderPoupanca(t); return a ? [a] : []; } },
  ];
  function modeloPorId(id) { return MODELOS.filter(function (m) { return m.id === id; })[0]; }

  /* ------------------------------------------------------------------ entrada */
  // ler(texto, arquivo, modeloId?) -> { extratos:[...], erro? }. Com modeloId (banco cadastrado) só tenta aquele
  // modelo; sem, descobre pelo conteúdo.
  function ler(texto, arquivo, modeloId) {
    var t = String(texto || "").replace(/\s+/g, " ");
    var modelo = modeloId ? modeloPorId(modeloId) : MODELOS.filter(function (m) { return m.reconhece(t); })[0];
    if (modeloId && !modelo) return { extratos: [], erro: "Modelo desconhecido: " + modeloId };
    if (!modelo) return { extratos: [], erro: "Formato não reconhecido -- ainda não temos modelo para este extrato de aplicação." };
    if (!modelo.reconhece(t)) return { extratos: [], erro: "O arquivo não parece do modelo \"" + modelo.nome + "\" -- confira o banco escolhido." };
    var lista = modelo.ler(t);
    if (!lista.length) return { extratos: [], erro: "Reconheci o modelo \"" + modelo.nome + "\", mas não consegui ler nenhuma aplicação neste arquivo." };
    lista.forEach(function (e) {
      e.id = e.produtoChave + "|" + e.mes + "|" + (e.agencia || "");
      e.arquivo = arquivo || "";
      e.modeloId = modelo.id;
    });
    return { extratos: lista };
  }

  var api = { ler: ler, fmt: fmt, r2: r2, MODELOS: MODELOS, modeloPorId: modeloPorId };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.AplicParsers = api;
})(typeof window !== "undefined" ? window : globalThis);
