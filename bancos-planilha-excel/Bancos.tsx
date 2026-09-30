import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FileInput, Pencil, TriangleAlert } from "lucide-react";
import { api } from "../lib/api.js";
import { useEmpresa } from "../lib/EmpresaContext.js";
import { chaveMesBr, MESES_ROTULO, recortarMes, resumoIgnorados, rotuloMes } from "../lib/mesesExtrato.js";
import type { BancoDisponivel, ContaFinanceira, LancamentoSalvo, TipoDocumento } from "../lib/types.js";
import Modal from "../components/Modal.js";
import BancoLogo from "../components/BancoLogo.js";
import RevisaoExtrato from "../components/RevisaoExtrato.js";
import { conferirRascunho } from "../lib/revisaoExtrato.js";
import type { LinhaRev, Rascunho } from "../lib/revisaoExtrato.js";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

function fmtDataHora(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function tempoLendo(ini: number): string {
  const s = Math.floor((Date.now() - ini) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function isoDeBr(d: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : d;
}

// Gerador de Excel "bonito" compartilhado com os apps estáticos (public/apps/_shared/excel-bonito.js).
function carregarExcelBonito(): Promise<any> {
  const w = window as any;
  if (w.ExcelBonito) return Promise.resolve(w.ExcelBonito);
  return new Promise((ok, erro) => {
    const s = document.createElement("script");
    s.src = "/apps/_shared/excel-bonito.js";
    s.onload = () => (w.ExcelBonito ? ok(w.ExcelBonito) : erro(new Error("Gerador de Excel indisponível.")));
    s.onerror = () => erro(new Error("Não consegui carregar o gerador de Excel."));
    document.head.appendChild(s);
  });
}

export default function Bancos() {
  const { empresa, recarregar, atualizarLocal } = useEmpresa();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [bancos, setBancos] = useState<BancoDisponivel[]>([]);
  const [modalAberto, setModalAberto] = useState(false);
  const [contaEditando, setContaEditando] = useState<ContaFinanceira | null>(null);
  const [modelosDe, setModelosDe] = useState<ContaFinanceira | null>(null);
  const [modeloAmpliado, setModeloAmpliado] = useState<number | null>(null);
  const [{ ano, mes }, setPeriodo] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return { ano: d.getFullYear(), mes: d.getMonth() + 1 };
  });
  const [lendo, setLendo] = useState<Record<string, number>>({});
  const [rascunho, setRascunho] = useState<Rascunho | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [colapsado, setColapsado] = useState(false);
  const [, setTick] = useState(0);
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const inputArquivoRef = useRef<HTMLInputElement>(null);
  const alvoRef = useRef<ContaFinanceira | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.bancos.listar().then(setBancos);
  }, []);

  // "Cadastrar banco" da barra lateral abre o modal aqui (?novo=1)
  useEffect(() => {
    if (searchParams.get("novo") === "1") {
      setContaEditando(null);
      setModalAberto(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // cronômetro da leitura (PDF escaneado passa por OCR e pode levar minutos)
  useEffect(() => {
    if (Object.keys(lendo).length === 0) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [lendo]);

  function avisar(msg: string, ms = 4200) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), ms);
  }

  const chaveMesAtual = `${ano}-${String(mes).padStart(2, "0")}`;

  // Por conta e mês: quantos lançamentos, entradas/saídas e se algum saldo do extrato diverge do calculado.
  const porContaMes = useMemo(() => {
    const mapa = new Map<
      string,
      { n: number; div: number; comSaldo: number; ent: number; sai: number; arquivo: string; salvoEm: string; ids: string[] }
    >();
    for (const l of empresa?.lancamentos ?? []) {
      if (l.tipoSaldo === "anterior") continue;
      const k = chaveMesBr(l.data);
      if (!k) continue;
      const chave = `${l.contaId}|${k}`;
      const atual = mapa.get(chave) ?? { n: 0, div: 0, comSaldo: 0, ent: 0, sai: 0, arquivo: "", salvoEm: "", ids: [] };
      atual.n += 1;
      atual.ids.push(l.id);
      if (l.valor > 0) atual.ent += l.valor;
      else atual.sai += l.valor;
      if (!atual.salvoEm || l.salvoEm > atual.salvoEm) {
        atual.salvoEm = l.salvoEm;
        atual.arquivo = l.arquivoOrigem;
      }
      if (l.saldoExtrato != null && l.saldoCalculado != null) {
        atual.comSaldo += 1;
        if (Math.abs(l.saldoExtrato - l.saldoCalculado) >= 0.01) atual.div += 1;
      }
      mapa.set(chave, atual);
    }
    return mapa;
  }, [empresa]);

  // #20 — extrato pode estar desatualizado: a última importação salva dessa
  // conta veio de uma versão do parser mais antiga que a registrada hoje?
  // Lançamentos salvos antes dessa feature não têm versaoParser/modelo
  // gravados — nesse caso não dá pra saber, então não avisa (evita falso
  // positivo em cima de todo o histórico antigo).
  const versaoDesatualizadaPorConta = useMemo(() => {
    const ultimoPorConta = new Map<string, LancamentoSalvo>();
    for (const l of empresa?.lancamentos ?? []) {
      const atual = ultimoPorConta.get(l.contaId);
      if (!atual || l.salvoEm > atual.salvoEm) ultimoPorConta.set(l.contaId, l);
    }

    const mapa = new Map<string, boolean>();
    for (const [contaId, ultimo] of ultimoPorConta) {
      if (!ultimo.versaoParser || !ultimo.modelo) continue;
      const conta = empresa?.contasBancarias.find((c) => c.id === contaId);
      if (!conta) continue;
      const banco = bancos.find((b) => b.instituicao === conta.bancoId);
      const versaoAtual = banco?.versoes?.[ultimo.modelo];
      if (versaoAtual && versaoAtual !== ultimo.versaoParser) {
        mapa.set(contaId, true);
      }
    }
    return mapa;
  }, [empresa, bancos]);

  async function excluirConta(contaId: string) {
    if (!empresa) return;
    const conta = empresa.contasBancarias.find((c) => c.id === contaId);
    const ids = empresa.lancamentos.filter((l) => l.contaId === contaId).map((l) => l.id);
    const msg =
      `Excluir o banco "${conta?.bancoNome ?? ""}"${conta?.contaBanco ? ` (${conta.contaBanco})` : ""}` +
      (ids.length ? ` e os ${ids.length} lançamento(s) dele? Os lançamentos vão pra Lixeira (recuperáveis por 30 dias).` : "?") +
      " Regras que valem só pra essa conta deixam de se aplicar.";
    if (!confirm(msg)) return;
    if (ids.length) await api.conversao.excluirLancamentos(empresa.id, ids);
    await api.contas.excluir(empresa.id, contaId);
    recarregar();
    avisar("Banco excluído.");
  }

  async function excluirExtratoDoMes(chave: string, ids: string[]) {
    if (!empresa || ids.length === 0) return;
    if (!confirm(`Excluir os ${ids.length} lançamento(s) desse banco em ${rotuloMes(chave)}? Eles vão pra Lixeira (recuperáveis por 30 dias).`)) return;
    await api.conversao.excluirLancamentos(empresa.id, ids);
    atualizarLocal({ lancamentos: empresa.lancamentos.filter((l) => !ids.includes(l.id)) });
    avisar("Excluído.");
  }

  function limparRascunho() {
    if (rascunho?.fileUrl) URL.revokeObjectURL(rascunho.fileUrl);
    setRascunho(null);
    setColapsado(false);
  }

  function trocarPeriodo(p: { ano: number; mes: number }) {
    if (rascunho) {
      if (!confirm("Você está revisando um extrato que ainda não foi salvo. Descartar e trocar de mês?")) return;
      limparRascunho();
    }
    setPeriodo(p);
  }

  function pedirArquivo(conta: ContaFinanceira) {
    alvoRef.current = conta;
    inputArquivoRef.current?.click();
  }

  // Anexar: lê o PDF (mesmos leitores do conversor), fica só com o mês selecionado e abre a REVISÃO -- nada vai pra Central
  // até o usuário conferir os saldos/lançamentos e clicar em "Salvar no mês".
  async function anexar(conta: ContaFinanceira, file: File) {
    if (!empresa) return;
    // "Planilha Excel (modelo próprio)" lê o .xlsx do modelo; todos os outros bancos leem PDF.
    const ehPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
    const ehPlanilha = /\.xlsx$/i.test(file.name);
    if (conta.bancoId === "planilha_excel") {
      if (!ehPlanilha) {
        avisar("Esse banco lê a planilha modelo (.xlsx). Anexe o arquivo Excel.");
        return;
      }
    } else if (!ehPdf) {
      avisar("Anexe um arquivo PDF.");
      return;
    }
    if (rascunho && !confirm("Você está revisando um extrato que ainda não foi salvo. Descartar e ler esse outro?")) return;
    if (rascunho) limparRascunho();

    const chave = chaveMesAtual;
    setLendo((p) => ({ ...p, [conta.id]: Date.now() }));
    try {
      const form = new FormData();
      form.append("arquivo", file);
      form.append("instituicao", conta.bancoId);
      form.append("contaId", conta.id);
      form.append("tipoDocumento", conta.tipoDocumento);
      const { documento } = await api.conversao.converter(empresa.id, form);

      if (
        documento.lidoViaOcr &&
        !window.confirm("Esse PDF não tem texto (é só imagem) e foi lido por OCR. O reconhecimento pode errar valores e datas -- confira na revisão. Continuar?")
      ) {
        return;
      }

      const r = recortarMes(documento, chave);
      const movs = r.lancamentos.filter((l) => l.tipoSaldo !== "anterior");
      if (movs.length === 0) {
        const outros = resumoIgnorados(r.ignorados);
        avisar(`${conta.bancoNome}: esse extrato não tem lançamentos de ${rotuloMes(chave)}${outros ? ` -- só de ${outros}. Escolha o mês certo.` : "."}`, 9000);
        return;
      }

      // fechamento calculado do mês anterior (mesma conta): encadeia o saldo inicial
      const [a, m] = chave.split("-").map(Number);
      const mesAnt = m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
      const doAnt = empresa.lancamentos.filter((l) => l.contaId === conta.id && l.tipoSaldo !== "anterior" && chaveMesBr(l.data) === mesAnt && l.saldoCalculado != null);
      const prevFinal = doAnt.length ? (doAnt.slice().sort((x, y) => (isoDeBr(x.data) < isoDeBr(y.data) ? -1 : isoDeBr(x.data) > isoDeBr(y.data) ? 1 : 0)).pop()!.saldoCalculado as number) : null;

      const linhas: LinhaRev[] = movs.map((l, i) => ({ ...l, id: `rev-${Date.now().toString(36)}-${i}`, saldoCalculado: null }));
      setRascunho({
        conta,
        mes: chave,
        arquivo: file.name,
        fileUrl: URL.createObjectURL(file),
        linhas,
        saldoInicial: r.saldoInicial,
        saldoFinal: r.saldoFinal,
        aviso: resumoIgnorados(r.ignorados),
        alterado: false,
        substituirIds: empresa.lancamentos.filter((l) => l.contaId === conta.id && chaveMesBr(l.data) === chave).map((l) => l.id),
        prevFinal,
        mesAnt: prevFinal !== null ? mesAnt : null,
      });
      setColapsado(true);
      setTimeout(() => document.getElementById("painel-revisao")?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
    } catch (e: any) {
      avisar(`${conta.bancoNome}: ${e.message ?? "não foi possível ler o arquivo."}`, 7000);
    } finally {
      setLendo((p) => {
        const novo = { ...p };
        delete novo[conta.id];
        return novo;
      });
    }
  }

  async function salvarRascunho() {
    if (!empresa || !rascunho) return;
    const conf = conferirRascunho(rascunho, (v) => brl.format(v));
    if (conf.status === "div" && !confirm(`Ainda tem divergência de saldo (${conf.texto}). Salvar mesmo assim?`)) return;
    if (rascunho.substituirIds.length > 0 && !confirm(`${rotuloMes(rascunho.mes)} desse banco já tem ${rascunho.substituirIds.length} lançamento(s). Substituir pelo novo extrato? (os atuais vão pra Lixeira)`)) return;

    setSalvando(true);
    try {
      const payload = conf.linhas.map((x) => {
        const { id: _id, manual: _manual, ...resto } = x.l;
        return { ...resto, saldoCalculado: x.calc, arquivoOrigem: rascunho.arquivo };
      });
      let base = empresa.lancamentos;
      if (rascunho.substituirIds.length > 0) {
        await api.conversao.excluirLancamentos(empresa.id, rascunho.substituirIds);
        base = base.filter((l) => !rascunho.substituirIds.includes(l.id));
      }
      const resultado = await api.conversao.salvarLancamentos(empresa.id, rascunho.conta.id, payload);
      atualizarLocal({ lancamentos: [...base, ...resultado.lancamentos] });
      avisar(`${payload.length} lançamento(s) de ${rascunho.conta.bancoNome} salvos em ${rotuloMes(rascunho.mes)}.`);
      limparRascunho();
    } catch (e: any) {
      avisar(`Não deu pra salvar: ${e.message ?? "erro desconhecido"}`, 7000);
    } finally {
      setSalvando(false);
    }
  }

  function descartarRascunho() {
    if (!rascunho) return;
    if (!confirm("Descartar esse extrato sem salvar?")) return;
    limparRascunho();
  }

  async function baixarExcel() {
    if (!empresa) return;
    const abas = empresa.contasBancarias
      .map((c) => ({ c, doMes: porContaMes.get(`${c.id}|${chaveMesAtual}`) }))
      .filter((x) => x.doMes)
      .map(({ c, doMes }) => ({
        nome: `${c.bancoNome} ${c.contaBanco}`.trim(),
        colunas: [
          { titulo: "Data", chave: "data", tipo: "data" },
          { titulo: "Histórico", chave: "hist", largura: 60 },
          { titulo: "Valor", chave: "valor", tipo: "moeda", total: true },
          { titulo: "Saldo do extrato", chave: "se", tipo: "moeda" },
          { titulo: "Saldo calculado", chave: "sc", tipo: "moeda" },
        ],
        linhas: empresa.lancamentos
          .filter((l) => l.contaId === c.id && l.tipoSaldo !== "anterior" && chaveMesBr(l.data) === chaveMesAtual)
          .map((l) => ({ data: isoDeBr(l.data), hist: l.historico, valor: l.valor, se: l.saldoExtrato ?? null, sc: l.saldoCalculado ?? null })),
        resumo: [
          ["Banco", c.bancoNome],
          ["Conta no banco", c.contaBanco || "—"],
          ["Conta no sistema", c.contaSistema || "—"],
          ["Lançamentos", doMes!.n],
          ["Entradas", r2(doMes!.ent)],
          ["Saídas", r2(doMes!.sai)],
        ],
      }));
    if (abas.length === 0) {
      avisar("Nenhum extrato anexado nesse mês.");
      return;
    }
    try {
      const eb = await carregarExcelBonito();
      await eb.baixar({
        arquivo: `Extratos ${rotuloMes(chaveMesAtual).replace("/", "-")} - ${empresa.nome}`,
        empresa: empresa.nome,
        titulo: `Extratos bancários — ${rotuloMes(chaveMesAtual)}`,
        abas,
      });
      avisar("Excel baixado.");
    } catch (e: any) {
      avisar(e.message ?? "Não deu pra gerar o Excel.");
    }
  }

  if (!empresa) {
    return <div className="mx-auto max-w-5xl px-8 py-8 text-sm text-text-muted">Carregando...</div>;
  }

  return (
    <div className="flex w-full flex-col gap-[34px] px-[clamp(18px,3vw,44px)] pb-[72px] pt-[30px]">
      <div className="flex flex-wrap items-end justify-between gap-3.5">
        <div>
          <p className="mb-1 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-warning">{empresa.nome} · Extratos</p>
          <h1 className="text-[clamp(20px,3vw,26px)] font-extrabold tracking-tight">Bancos</h1>
        </div>
        <button onClick={baixarExcel} className="btn btn-ghost btn-sm" title="Baixa um Excel com os extratos anexados nesse mês">
          ⬇ Excel
        </button>
      </div>

      <div>
        <button
          onClick={() => setColapsado((c) => !c)}
          title="Recolher / abrir os bancos"
          className="inline-flex items-center gap-2 px-0.5 py-1 text-sm font-bold"
        >
          <span className="w-3.5 text-xs text-text-muted">{colapsado ? "▸" : "▾"}</span>
          Bancos
          <small className="text-[11.5px] font-medium text-text-faint">
            {empresa.contasBancarias.length} · {rotuloMes(chaveMesAtual)}
          </small>
        </button>
      </div>

      <div className={colapsado ? "hidden" : "flex flex-col gap-[34px]"}>
      <div>
        <div className="mb-4 flex items-center gap-1">
          <button
            onClick={() => trocarPeriodo({ ano: ano - 1, mes })}
            title="Ano anterior"
            className="h-[26px] w-[26px] rounded-md text-[17px] leading-none text-text-faint transition hover:bg-hover hover:text-text"
          >
            ‹
          </button>
          <span className="w-14 text-center text-[19px] font-semibold tabular-nums">{ano}</span>
          <button
            onClick={() => trocarPeriodo({ ano: ano + 1, mes })}
            title="Próximo ano"
            className="h-[26px] w-[26px] rounded-md text-[17px] leading-none text-text-faint transition hover:bg-hover hover:text-text"
          >
            ›
          </button>
        </div>
        <div className="flex gap-1 rounded-xl bg-surface2 p-[5px]">
          {MESES_ROTULO.map((nome, i) => {
            const m = i + 1;
            const chave = `${ano}-${String(m).padStart(2, "0")}`;
            const total = empresa.contasBancarias.length;
            const feitas = empresa.contasBancarias.filter((c) => (porContaMes.get(`${c.id}|${chave}`)?.n ?? 0) > 0).length;
            const ativo = m === mes;
            return (
              <button
                key={nome}
                onClick={() => trocarPeriodo({ ano, mes: m })}
                title={`${nome}/${ano} -- ${feitas} de ${total} conta(s) com extrato`}
                className={
                  "flex min-w-0 flex-1 flex-col items-center rounded-lg border py-2.5 text-[12.5px] font-semibold transition " +
                  (ativo ? "border-border-strong bg-surface text-text shadow-sm" : "border-transparent text-text-muted hover:bg-hover hover:text-text") +
                  (feitas === 0 && !ativo ? " opacity-50" : "")
                }
              >
                {nome}
                <span
                  className={
                    "text-[10.5px] font-medium tabular-nums " +
                    (feitas === total && total > 0 ? "text-success" : feitas > 0 ? "text-warning" : "text-text-faint")
                  }
                >
                  {total ? `${feitas}/${total}` : "·"}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4">
        {empresa.contasBancarias.map((conta) => {
          const doMes = porContaMes.get(`${conta.id}|${chaveMesAtual}`);
          const iniciouEm = lendo[conta.id];
          return (
            <div
              key={conta.id}
              onDragOver={(e) => {
                e.preventDefault();
                setArrastando(conta.id);
              }}
              onDragLeave={() => setArrastando((a) => (a === conta.id ? null : a))}
              onDrop={(e) => {
                e.preventDefault();
                setArrastando(null);
                const f = e.dataTransfer.files?.[0];
                if (f) anexar(conta, f);
              }}
              className={
                "flex flex-col gap-3 rounded-xl border p-4 shadow-card transition " +
                (arrastando === conta.id ? "border-brand bg-brand/5" : "border-border bg-surface")
              }
            >
              <div className="flex items-center gap-[11px]">
                <BancoLogo bancoId={conta.bancoId} nome={conta.bancoNome} cartao={conta.tipoDocumento === "fatura_cartao"} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-bold leading-tight">{conta.bancoNome}</div>
                  <div className="text-[11.5px] text-text-faint">{conta.tipoDocumento === "fatura_cartao" ? "Fatura de cartão" : "Extrato bancário"}</div>
                </div>
                <button
                  onClick={() => {
                    setModeloAmpliado(null);
                    setModelosDe(conta);
                  }}
                  title="Ver os extratos aceitos desse banco"
                  className="h-[26px] w-[26px] shrink-0 rounded-full border border-border-strong text-[13px] font-extrabold leading-none text-text-muted transition hover:border-brand hover:bg-brand/10 hover:text-brand"
                >
                  !
                </button>
                <button
                  onClick={() => {
                    setContaEditando(conta);
                    setModalAberto(true);
                  }}
                  title="Editar banco"
                  className="rounded-md border border-border-strong p-1.5 text-text-muted transition hover:bg-hover hover:text-text"
                >
                  <Pencil size={13} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-x-3.5 gap-y-2.5 border-t border-border pt-2.5">
                <div>
                  <div className="text-[9.5px] font-bold uppercase tracking-[0.07em] text-text-faint">Nº da conta no banco</div>
                  <div className="mt-[3px] font-mono text-xs font-semibold">{conta.contaBanco || "—"}</div>
                </div>
                <div>
                  <div className="text-[9.5px] font-bold uppercase tracking-[0.07em] text-text-faint">Nº da conta no sistema</div>
                  <div className="mt-[3px] font-mono text-xs font-semibold">{conta.contaSistema || "—"}</div>
                </div>
              </div>

              <div
                className={
                  "flex flex-col gap-[9px] rounded-[10px] border px-[13px] py-[11px] " +
                  (iniciouEm || !doMes ? "border-dashed border-border" : doMes.div > 0 ? "border-danger/50 bg-danger/5" : "border-border bg-hover/40")
                }
              >
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-[13px] font-bold">{`${MESES_LONGO[mes - 1]}/${ano}`}</span>
                  {iniciouEm ? (
                    <span className="rounded-full border border-border-strong px-[11px] py-[3px] text-[11px] font-bold text-text-muted">
                      lendo… {tempoLendo(iniciouEm)}
                    </span>
                  ) : !doMes ? (
                    <span className="rounded-full border border-warning/50 bg-warning/10 px-[11px] py-[3px] text-[11px] font-bold text-warning">sem extrato</span>
                  ) : doMes.div > 0 ? (
                    <span className="rounded-full border border-danger/50 bg-danger/10 px-[11px] py-[3px] text-[11px] font-bold text-danger">
                      ⚠ {doMes.div} saldo(s) divergente(s)
                    </span>
                  ) : doMes.comSaldo > 0 ? (
                    <span className="rounded-full border border-success/50 bg-success/10 px-[11px] py-[3px] text-[11px] font-bold text-success">✓ Saldos conferem</span>
                  ) : (
                    <span className="rounded-full border border-border-strong px-[11px] py-[3px] text-[11px] font-bold text-text-muted">importado</span>
                  )}
                </div>

                {iniciouEm ? (
                  <small className="text-[11px] leading-snug text-text-faint">
                    Lendo o extrato e conferindo os saldos. Se o PDF for uma imagem (escaneado), a leitura por OCR pode levar alguns minutos -- pode deixar rodando.
                  </small>
                ) : doMes ? (
                  <>
                    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] tabular-nums text-text-muted">
                      <span>
                        Lançamentos <b className="text-text">{doMes.n}</b>
                      </span>
                      <span>
                        Entradas <b className="text-text">{brl.format(r2(doMes.ent))}</b>
                      </span>
                      <span>
                        Saídas <b className="text-text">{brl.format(r2(doMes.sai))}</b>
                      </span>
                    </div>
                    <small className="truncate text-[11px] text-text-faint">
                      {doMes.arquivo} · anexado em {fmtDataHora(doMes.salvoEm)}
                    </small>
                  </>
                ) : (
                  <small className="text-[11px] leading-snug text-text-faint">
                    {conta.bancoId === "planilha_excel" ? "Arraste a planilha (.xlsx) pra cá ou escolha o arquivo." : "Arraste o PDF do extrato pra cá ou escolha o arquivo."}
                  </small>
                )}

                {versaoDesatualizadaPorConta.has(conta.id) && !iniciouEm && (
                  <div className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                    <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                    Extrato pode estar desatualizado — a leitura desse banco foi corrigida depois da última importação. Considere reanexar.
                  </div>
                )}

                {!iniciouEm && (
                  <div className="flex flex-wrap gap-1.5">
                    {!doMes ? (
                      <button onClick={() => pedirArquivo(conta)} className="btn btn-primary btn-sm !px-[9px] !py-1 !text-[11.5px]">
                        ⭱ Anexar extrato
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => navigate(`/empresas/${empresa.id}/lancamentos?conta=${conta.id}&mes=${chaveMesAtual}`)}
                          className={"btn btn-sm !px-[9px] !py-1 !text-[11.5px] " + (doMes.div > 0 ? "btn-primary" : "btn-secondary")}
                        >
                          {doMes.div > 0 ? "⚠ Resolver divergência" : "Ver / editar lançamentos"}
                        </button>
                        <button onClick={() => pedirArquivo(conta)} className="btn btn-ghost btn-sm !px-[9px] !py-1 !text-[11.5px]">
                          Trocar extrato
                        </button>
                        <button onClick={() => excluirExtratoDoMes(chaveMesAtual, doMes.ids)} className="btn btn-ghost btn-sm text-danger !px-[9px] !py-1 !text-[11.5px]">
                          Excluir
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <button
          onClick={() => {
            setContaEditando(null);
            setModalAberto(true);
          }}
          className="flex min-h-[110px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong text-[13px] font-semibold text-text-muted transition hover:border-brand hover:bg-brand/5 hover:text-text"
        >
          <span className="text-[26px] leading-none text-brand">+</span>
          Cadastrar banco
        </button>
      </div>

      </div>

      {rascunho && (
        <div id="painel-revisao">
          <RevisaoExtrato rascunho={rascunho} onChange={setRascunho} onSalvar={salvarRascunho} onDescartar={descartarRascunho} salvando={salvando} />
        </div>
      )}

      <input
        ref={inputArquivoRef}
        type="file"
        accept=".pdf,application/pdf,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f && alvoRef.current) anexar(alvoRef.current, f);
        }}
      />

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 max-w-lg -translate-x-1/2 rounded-lg bg-text px-4 py-2.5 text-[13px] font-medium text-bg shadow-card">{toast}</div>
      )}

      {modelosDe && (
        <Modal
          titulo={`Extratos aceitos — ${modelosDe.bancoNome}`}
          onClose={() => {
            setModelosDe(null);
            setModeloAmpliado(null);
          }}
          largura="max-w-4xl"
        >
          {(() => {
            const imgs = bancos.find((b) => b.instituicao === modelosDe.bancoId)?.imagensModelo ?? [];
            if (imgs.length === 0) return <p className="text-sm text-text-muted">Sem imagem de exemplo pra esse banco ainda.</p>;
            if (modeloAmpliado !== null && imgs[modeloAmpliado]) {
              return (
                <div className="flex flex-col gap-3">
                  <button onClick={() => setModeloAmpliado(null)} className="btn btn-ghost btn-sm self-start">
                    ‹ Todos os modelos
                  </button>
                  <img src={imgs[modeloAmpliado]} alt={`Modelo ${modeloAmpliado + 1}`} className="w-full rounded-lg border border-border bg-white" />
                </div>
              );
            }
            return (
              <div>
                <p className="mb-4 text-xs text-text-muted">
                  Esses são os layouts que o leitor aceita pra {modelosDe.bancoNome}. O arquivo precisa ser um PDF igual a um deles (dados da empresa borrados nas imagens).
                  Clique numa imagem pra ampliar.
                </p>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {imgs.map((src, i) => (
                    <button
                      key={src}
                      onClick={() => setModeloAmpliado(i)}
                      className="overflow-hidden rounded-xl border border-border bg-surface2 text-center text-[11.5px] font-semibold text-text-muted transition hover:border-brand"
                    >
                      <img src={src} alt={`Modelo ${i + 1}`} className="h-56 w-full bg-white object-cover object-top" />
                      <span className="block py-1.5">{imgs.length > 1 ? `Modelo ${i + 1}` : "Modelo aceito"}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
        </Modal>
      )}

      {modalAberto && (
        <ContaModal
          empresaId={empresa.id}
          conta={contaEditando}
          bancos={bancos}
          onClose={() => setModalAberto(false)}
          onSalvo={() => {
            setModalAberto(false);
            recarregar();
          }}
          onExcluir={
            contaEditando
              ? () => {
                  const id = contaEditando.id;
                  setModalAberto(false);
                  excluirConta(id);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

const MESES_LONGO = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

function ContaModal({
  empresaId,
  conta,
  bancos,
  onClose,
  onSalvo,
  onExcluir,
}: {
  empresaId: string;
  conta: ContaFinanceira | null;
  bancos: BancoDisponivel[];
  onClose: () => void;
  onSalvo: () => void;
  onExcluir?: () => void;
}) {
  const [tipoDocumento, setTipoDocumento] = useState<TipoDocumento>(conta?.tipoDocumento ?? "extrato_bancario");
  const [bancoId, setBancoId] = useState(conta?.bancoId ?? bancos[0]?.instituicao ?? "");
  const [contaBanco, setContaBanco] = useState(conta?.contaBanco ?? "");
  const [contaSistema, setContaSistema] = useState(conta?.contaSistema ?? "");
  const [erro, setErro] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [imagemAmpliadaIdx, setImagemAmpliadaIdx] = useState<number | null>(null);

  const bancoSelecionado = bancos.find((b) => b.instituicao === bancoId);

  async function salvar() {
    setErro("");
    if (!bancoId) return setErro("Selecione um banco.");
    if (!contaBanco.trim()) return setErro("Informe a conta do banco.");
    if (!contaSistema.trim()) return setErro("Informe a conta do sistema.");

    setSalvando(true);
    try {
      const dados = {
        tipoDocumento,
        bancoId,
        bancoNome: bancoSelecionado?.nome ?? bancoId,
        contaBanco: contaBanco.trim(),
        contaSistema: contaSistema.trim(),
      };

      if (conta) {
        await api.contas.atualizar(empresaId, conta.id, dados);
      } else {
        await api.contas.criar(empresaId, dados);
      }
      onSalvo();
    } catch (e: any) {
      setErro(e.message ?? "Não foi possível salvar.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Modal titulo={conta ? "Editar conta" : "Adicionar conta"} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="label-caps mb-1.5 block">
            Tipo de documento
          </label>
          <div className="flex gap-2">
            {(["extrato_bancario", "fatura_cartao"] as TipoDocumento[]).map((tipo) => (
              <button
                key={tipo}
                onClick={() => setTipoDocumento(tipo)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  tipoDocumento === tipo
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-border text-text-secondary hover:bg-hover"
                }`}
              >
                {tipo === "extrato_bancario" ? "Extrato bancário" : "Fatura de cartão"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label-caps mb-1.5 block">
            Banco
          </label>
          <select
            value={bancoId}
            onChange={(e) => setBancoId(e.target.value)}
            className="field w-full"
          >
            {bancos.length === 0 && <option value="">Nenhum banco disponível ainda</option>}
            {bancos
              .filter((b) => b.tipoDocumento === tipoDocumento)
              .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
              .map((b) => (
                <option key={b.instituicao} value={b.instituicao}>
                  {b.nome}
                </option>
              ))}
          </select>

          {bancoSelecionado?.instituicao === "planilha_excel" && (
            <div className="mt-3 rounded-lg border border-border bg-surface2 p-3">
              <p className="mb-2 text-xs font-medium text-text-secondary">
                Sem extrato de banco pra esse lançamento? Baixe o modelo, preencha e importe de volta.
              </p>
              <a
                href="/api/modelos/planilha-excel.xlsx"
                className="btn btn-secondary btn-sm inline-flex"
              >
                <FileInput size={14} />
                Baixar planilha modelo (.xlsx)
              </a>
            </div>
          )}

          {bancoSelecionado && bancoSelecionado.instituicao !== "planilha_excel" && (
            <div className="mt-3 rounded-lg border border-border bg-surface2 p-3">
              <p className="mb-2 text-xs font-medium text-text-secondary">
                Modelo de {tipoDocumento === "fatura_cartao" ? "fatura" : "extrato"} aceito ·{" "}
                {bancoSelecionado.nome}
              </p>
              {bancoSelecionado.imagensModelo.length > 0 ? (
                <div className={bancoSelecionado.imagensModelo.length > 1 ? "grid grid-cols-2 gap-2" : ""}>
                  {bancoSelecionado.imagensModelo.map((img, idx) => (
                    <button
                      key={img}
                      type="button"
                      onClick={() => setImagemAmpliadaIdx(idx)}
                      className="block overflow-hidden rounded-md border border-border transition hover:opacity-80"
                    >
                      <img
                        src={img}
                        alt={`Modelo ${idx + 1} aceito para ${bancoSelecionado.nome}`}
                        className="h-28 w-full object-cover object-top"
                      />
                      {bancoSelecionado.imagensModelo.length > 1 && (
                        <span className="block bg-surface2 px-1.5 py-0.5 text-center text-[11px] font-medium text-text-muted">
                          Modelo {idx + 1}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-text-muted">Sem imagem de exemplo pra esse banco ainda.</p>
              )}
            </div>
          )}
        </div>

        {imagemAmpliadaIdx !== null && bancoSelecionado?.imagensModelo[imagemAmpliadaIdx] && (
          <Modal
            titulo={
              bancoSelecionado.imagensModelo.length > 1
                ? `Modelo ${imagemAmpliadaIdx + 1} aceito — ${bancoSelecionado.nome}`
                : `Modelo aceito — ${bancoSelecionado.nome}`
            }
            onClose={() => setImagemAmpliadaIdx(null)}
            largura="max-w-2xl"
          >
            <img
              src={bancoSelecionado.imagensModelo[imagemAmpliadaIdx]}
              alt={`Modelo aceito para ${bancoSelecionado.nome}`}
              className="w-full rounded-lg border border-border"
            />
          </Modal>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label-caps mb-1.5 block">
              Conta do banco
            </label>
            <input
              value={contaBanco}
              onChange={(e) => setContaBanco(e.target.value)}
              placeholder="Ex: CC 12345-6"
              className="field w-full"
            />
          </div>
          <div>
            <label className="label-caps mb-1.5 block">
              Conta do sistema
            </label>
            <input
              value={contaSistema}
              onChange={(e) => setContaSistema(e.target.value)}
              placeholder="Ex: 1101"
              className="field w-full"
            />
          </div>
        </div>

        {erro && <div className="rounded-lg bg-danger/10 px-3.5 py-2.5 text-sm text-danger">{erro}</div>}

        <div className="flex justify-end gap-2 pt-2">
          {onExcluir && (
            <button onClick={onExcluir} className="btn btn-ghost btn-md mr-auto text-danger">
              Excluir banco
            </button>
          )}
          <button onClick={onClose} className="btn btn-secondary btn-md">
            Cancelar
          </button>
          <button onClick={salvar} disabled={salvando} className="btn btn-primary btn-md">
            {salvando ? "Salvando..." : "Salvar conta"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
