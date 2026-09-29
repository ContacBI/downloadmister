import { Router } from "express";
import { randomUUID } from "node:crypto";
import { buscarLancamentosCaixaBling, listarContasFinanceirasBling, type LancamentoBrutoBling } from "../integrations/bling.js";
import {
  addConta,
  anosDisponiveis,
  atualizarConta,
  desvincularParcela,
  getContas,
  getDocumento,
  getRegras,
  mesesDisponiveis,
  removerConta,
  salvarDocumento,
  salvarRegras,
  todosDocumentos,
  vincularParcela,
} from "../storage/cuffBancariaRepository.js";
import * as controlesRepo from "../storage/controlesRepository.js";
import type { LancamentoCuff, RegraCuff } from "../domain/cuffBancariaTypes.js";

// Módulo "Conciliação Bancária" do Grupo Cuff -- ver comentário completo em
// CUFF_BANCARIA_DIR (config.ts) e cuffBancariaTypes.ts. Só espelha o extrato
// do Bling por conta+mês, sem comparar contra relatório contábil nenhum --
// o "Central de Lançamentos"/"Regras"/"Configurações" aqui seguem o mesmo
// desenho do MIB (ver routes/mib.ts), adaptados: sem extrato x relatório,
// conta contábil só opcional, por regra (Cód Domínio da contrapartida) --
// "Regras" atribui uma categoriaPropria livre e, se preenchida, a conta contábil, e "vincular" liga um
// lançamento a uma parcela de Empréstimo (Controles) em vez de casar com o
// outro lado de uma conciliação.
export const cuffBancariaRouter = Router();

function ultimoDiaDoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

function normalizarLancamento(bruto: LancamentoBrutoBling): LancamentoCuff {
  // Confirmado ao vivo contra dados reais: `descricao` do Bling é a
  // "Categoria" da tela, `observacoes` é o "Histórico" de verdade. O
  // Cliente/Fornecedor (contato) não vira coluna própria -- pedido do
  // Izaias (09/09/2026): junta no fim do histórico, "HISTÓRICO - CLIENTE",
  // já na importação (não é só na tela -- fica assim salvo).
  const historicoBase = bruto.observacoes ?? "";
  const historico = bruto.contato?.nome ? `${historicoBase} - ${bruto.contato.nome}` : historicoBase;
  return {
    id: bruto.id,
    data: bruto.data,
    valor: Number(bruto.valor) || 0,
    debCred: bruto.debCred === "C" ? "C" : "D",
    situacao: bruto.situacao,
    categoria: bruto.descricao ?? "",
    historico,
    contatoNome: bruto.contato?.nome,
    contatoCnpj: bruto.contato?.cnpj,
    origemId: bruto.origem?.id,
  };
}

// ---------------------------------------------------------------------------
// Engine de Regras -- mesma ideia do MIB (aplicarRegras em mibRepository
// não existe lá como função exportada; a MIB reprocessa no cliente. Aqui
// fica no servidor, mais simples de garantir consistência entre a Central
// de Lançamentos e a tela de extrato). Só bate contra `historico`.
// ---------------------------------------------------------------------------
function regraBate(regra: RegraCuff, l: LancamentoCuff, contaId: string): boolean {
  if (!regra.ativa) return false;
  if (regra.tipo && regra.tipo !== l.debCred) return false;
  if (regra.contaId && regra.contaId !== contaId) return false;
  if (regra.valor != null) {
    if (Math.abs(Math.abs(l.valor) - regra.valor) > 0.005) return false;
    if (!regra.texto) return true;
  }
  const alvo = l.historico.toLowerCase();
  const texto = regra.texto.toLowerCase();
  switch (regra.modo) {
    case "contem": return alvo.includes(texto);
    case "comeca": return alvo.startsWith(texto);
    case "termina": return alvo.endsWith(texto);
    case "exato": return alvo === texto;
    case "regex":
      try { return new RegExp(regra.texto, "i").test(l.historico); } catch { return false; }
    default: return false;
  }
}

function aplicarRegras(lancamentos: LancamentoCuff[], regras: RegraCuff[], contaId: string): void {
  const ativasOrdenadas = regras.filter((r) => r.ativa).sort((a, b) => a.ordem - b.ordem);
  for (const l of lancamentos) {
    const regra = ativasOrdenadas.find((r) => regraBate(r, l, contaId));
    l.categoriaPropria = regra ? regra.categoriaPropria : null;
    l.historicoPadrao = regra ? regra.historicoPadrao || null : null;
    // Conta contábil (Cód Domínio) da contrapartida -- gravada no lançamento, igual à categoria e ao histórico padrão.
    l.contaContabil = regra ? regra.contaContabil || null : null;
  }
}

// ---------------------------------------------------------------------------
// Catálogo de contas do Bling (a conexão é única pro grupo inteiro, não é
// por empresa) -- usado na tela de "Gerenciar contas" pra escolher entre as
// disponíveis.
// ---------------------------------------------------------------------------
cuffBancariaRouter.get("/cuff-bancaria/contas-bling-disponiveis", async (_req, res) => {
  try {
    const contas = await listarContasFinanceirasBling();
    res.json(contas);
  } catch (erro: any) {
    res.status(502).json({ erro: erro.message });
  }
});

// ---------------------------------------------------------------------------
// Contas bancárias registradas por empresa
// ---------------------------------------------------------------------------
cuffBancariaRouter.get("/cuff-bancaria/empresas/:empresaId/contas", async (req, res) => {
  res.json(await getContas(req.params.empresaId));
});

cuffBancariaRouter.post("/cuff-bancaria/empresas/:empresaId/contas", async (req, res) => {
  const { idContaFinanceira, descricaoBling, tipo, apelido } = req.body ?? {};
  if (!idContaFinanceira || !apelido?.trim()) {
    res.status(400).json({ erro: "Informe a conta do Bling e um apelido." });
    return;
  }
  const jaTem = (await getContas(req.params.empresaId)).some((c) => c.idContaFinanceira === Number(idContaFinanceira));
  if (jaTem) {
    res.status(400).json({ erro: "Essa conta já está cadastrada pra essa empresa." });
    return;
  }
  const conta = await addConta(req.params.empresaId, {
    idContaFinanceira: Number(idContaFinanceira),
    descricaoBling: String(descricaoBling ?? ""),
    tipo: String(tipo ?? ""),
    apelido: apelido.trim(),
  });
  res.json(conta);
});

cuffBancariaRouter.put("/cuff-bancaria/empresas/:empresaId/contas/:contaId", async (req, res) => {
  const { apelido, contaSistema, contaSaldoCredor, blingAutoHoras } = req.body ?? {};
  if (apelido !== undefined && !String(apelido).trim()) {
    res.status(400).json({ erro: "Apelido não pode ficar vazio." });
    return;
  }
  const patch: Record<string, unknown> = {};
  if (apelido !== undefined) patch.apelido = String(apelido).trim();
  if (contaSistema !== undefined) patch.contaSistema = String(contaSistema).trim();
  if (contaSaldoCredor !== undefined) patch.contaSaldoCredor = String(contaSaldoCredor).trim();
  if (blingAutoHoras !== undefined) patch.blingAutoHoras = blingAutoHoras === null || blingAutoHoras === "" ? null : Number(blingAutoHoras);
  const contas = await atualizarConta(req.params.empresaId, req.params.contaId, patch);
  res.json(contas);
});

cuffBancariaRouter.delete("/cuff-bancaria/empresas/:empresaId/contas/:contaId", async (req, res) => {
  await removerConta(req.params.empresaId, req.params.contaId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Meses/anos disponíveis (pra grade de meses, mesmo padrão da Conciliação NFS-e)
// ---------------------------------------------------------------------------
cuffBancariaRouter.get("/cuff-bancaria/empresas/:empresaId/contas/:contaId/anos", async (req, res) => {
  const anos = await anosDisponiveis(req.params.empresaId, req.params.contaId);
  const atual = new Date().getFullYear();
  if (!anos.includes(atual)) anos.push(atual);
  res.json(anos.sort());
});

cuffBancariaRouter.get("/cuff-bancaria/empresas/:empresaId/contas/:contaId/:ano/meses", async (req, res) => {
  const meses = await mesesDisponiveis(req.params.empresaId, req.params.contaId, Number(req.params.ano));
  res.json(meses);
});

// ---------------------------------------------------------------------------
// Lançamentos de 1 conta + 1 mês -- lê o cache local; "buscar" repuxa do
// Bling e substitui o cache (reaplicando as regras vigentes).
// ---------------------------------------------------------------------------
cuffBancariaRouter.get("/cuff-bancaria/empresas/:empresaId/contas/:contaId/:ano/:mes", async (req, res) => {
  const doc = await getDocumento(req.params.empresaId, req.params.contaId, Number(req.params.ano), Number(req.params.mes));
  res.json(doc);
});

cuffBancariaRouter.post("/cuff-bancaria/empresas/:empresaId/contas/:contaId/:ano/:mes/buscar", async (req, res) => {
  try {
    const { empresaId, contaId } = req.params;
    const ano = Number(req.params.ano);
    const mes = Number(req.params.mes);
    const conta = (await getContas(empresaId)).find((c) => c.id === contaId);
    if (!conta) {
      res.status(404).json({ erro: "Conta não encontrada pra essa empresa." });
      return;
    }
    const dataInicial = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const dataFinal = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDiaDoMes(ano, mes)).padStart(2, "0")}`;
    const brutos = await buscarLancamentosCaixaBling(conta.idContaFinanceira, dataInicial, dataFinal);
    const lancamentos = brutos.map(normalizarLancamento);
    // Reaplica as regras vigentes, mas PRESERVA o vínculo com Controles de
    // uma busca anterior (o id do lançamento no Bling é estável) -- sem
    // isso, todo "Atualizar do Bling" desfazia silenciosamente qualquer
    // vínculo já feito na mão.
    const anterior = await getDocumento(empresaId, contaId, ano, mes);
    const vinculosAnteriores = new Map((anterior?.lancamentos ?? []).map((l) => [l.id, l]));
    for (const l of lancamentos) {
      const antigo = vinculosAnteriores.get(l.id);
      if (antigo?.vinculoControleId) {
        l.vinculoControleId = antigo.vinculoControleId;
        l.vinculoParcela = antigo.vinculoParcela;
      }
    }
    aplicarRegras(lancamentos, await getRegras(empresaId), contaId);
    const doc = { empresaId, contaId, ano, mes, lancamentos, buscadoEm: new Date().toISOString() };
    await salvarDocumento(doc);
    res.json(doc);
  } catch (erro: any) {
    res.status(502).json({ erro: erro.message });
  }
});

// ---------------------------------------------------------------------------
// Regras de categorização (CRUD) -- ver aplicarRegras acima.
// ---------------------------------------------------------------------------
cuffBancariaRouter.get("/cuff-bancaria/empresas/:empresaId/regras", async (req, res) => {
  res.json(await getRegras(req.params.empresaId));
});

cuffBancariaRouter.put("/cuff-bancaria/empresas/:empresaId/regras", async (req, res) => {
  const recebidas = Array.isArray(req.body) ? (req.body as RegraCuff[]) : [];
  // contaContabil: só dígitos (código reduzido do Domínio); vazio/inválido vira "sem conta".
  const lista = recebidas.map((r) => {
    const cod = r.contaContabil == null ? "" : String(r.contaContabil).trim();
    return { ...r, contaContabil: /^\d+$/.test(cod) ? cod : undefined };
  });
  await salvarRegras(req.params.empresaId, lista);
  res.json(lista);
});

// Reaplica as regras vigentes em TODOS os meses/contas já salvos (chamado
// depois de criar/editar/reordenar uma regra) -- sem isso, o mês só ganharia
// a categoria nova na próxima vez que fosse buscado do Bling de novo.
cuffBancariaRouter.post("/cuff-bancaria/empresas/:empresaId/regras/reprocessar", async (req, res) => {
  const { empresaId } = req.params;
  const regras = await getRegras(empresaId);
  const docs = await todosDocumentos(empresaId);
  for (const doc of docs) {
    aplicarRegras(doc.lancamentos, regras, doc.contaId);
    await salvarDocumento(doc);
  }
  res.json({ ok: true, documentosAtualizados: docs.length });
});

// ---------------------------------------------------------------------------
// Central de Lançamentos -- empresa inteira, todas as contas/meses juntos.
// ---------------------------------------------------------------------------
cuffBancariaRouter.get("/cuff-bancaria/empresas/:empresaId/central", async (req, res) => {
  const contas = await getContas(req.params.empresaId);
  const contasPorId = new Map(contas.map((c) => [c.id, c]));
  const docs = await todosDocumentos(req.params.empresaId);
  const linhas = docs.flatMap((doc) =>
    doc.lancamentos.map((l) => ({
      ...l,
      contaId: doc.contaId,
      contaApelido: contasPorId.get(doc.contaId)?.apelido ?? doc.contaId,
      ano: doc.ano,
      mes: doc.mes,
    }))
  );
  res.json(linhas);
});

// ---------------------------------------------------------------------------
// Vincular/desvincular lançamento <-> parcela de Empréstimo (Controles) --
// versão simplificada do "baixar-parcela" do MIB (routes/controles.ts): só
// marca o vínculo, não desmembra em pernas de débito/crédito (sem conta
// contábil, o Cuff não exporta pra sistema contábil nenhum ainda).
// ---------------------------------------------------------------------------
cuffBancariaRouter.post("/cuff-bancaria/empresas/:empresaId/contas/:contaId/:ano/:mes/vincular", async (req, res) => {
  const { empresaId, contaId } = req.params;
  const ano = Number(req.params.ano);
  const mes = Number(req.params.mes);
  const { lancamentoId, emprestimoId, parcela } = req.body ?? {};
  if (!lancamentoId || !emprestimoId || !Number.isInteger(parcela)) {
    res.status(400).json({ erro: "Informe lancamentoId, emprestimoId e o número da parcela." });
    return;
  }
  const emprestimos = await controlesRepo.listarEmprestimos(empresaId);
  const emprestimo = emprestimos.find((e) => e.id === emprestimoId);
  if (!emprestimo) {
    res.status(404).json({ erro: "Empréstimo não encontrado." });
    return;
  }
  const doc = await getDocumento(empresaId, contaId, ano, mes);
  const lancamento = doc?.lancamentos.find((l) => l.id === lancamentoId);
  if (!doc || !lancamento) {
    res.status(404).json({ erro: "Lançamento não encontrado nesse mês." });
    return;
  }
  await vincularParcela(empresaId, contaId, ano, mes, lancamentoId, emprestimoId, parcela);
  const pagamentos = (emprestimo.pagamentos || []).filter((p) => p.numero !== parcela);
  pagamentos.push({ numero: parcela, dataPagamento: lancamento.data });
  await controlesRepo.salvarEmprestimo(empresaId, { ...emprestimo, pagamentos });
  res.json({ ok: true });
});

cuffBancariaRouter.post("/cuff-bancaria/empresas/:empresaId/contas/:contaId/:ano/:mes/desvincular", async (req, res) => {
  const { empresaId, contaId } = req.params;
  const ano = Number(req.params.ano);
  const mes = Number(req.params.mes);
  const { lancamentoId } = req.body ?? {};
  if (!lancamentoId) {
    res.status(400).json({ erro: "Informe o lancamentoId." });
    return;
  }
  const doc = await getDocumento(empresaId, contaId, ano, mes);
  const lancamento = doc?.lancamentos.find((l) => l.id === lancamentoId);
  if (lancamento?.vinculoControleId && lancamento.vinculoParcela != null) {
    const emprestimos = await controlesRepo.listarEmprestimos(empresaId);
    const emprestimo = emprestimos.find((e) => e.id === lancamento.vinculoControleId);
    if (emprestimo) {
      const pagamentos = (emprestimo.pagamentos || []).filter((p) => p.numero !== lancamento.vinculoParcela);
      await controlesRepo.salvarEmprestimo(empresaId, { ...emprestimo, pagamentos });
    }
  }
  await desvincularParcela(empresaId, contaId, ano, mes, lancamentoId);
  res.json({ ok: true });
});

// "Vincular tudo" -- pedido explícito do Izaias (08/09/2026): em vez de
// vincular parcela por parcela na mão, varre TODOS os lançamentos já
// buscados (todos os meses/contas) de uma vez, e pra cada empréstimo ATIVO
// com `referenciaHistorico` preenchido, casa automaticamente qualquer
// lançamento de SAÍDA (débito) cujo `historico` contenha esse texto E cujo
// valor bata (tolerância de 1 centavo, evita falso positivo por
// arredondamento) com o valor da parcela -- só entra o que ainda não tinha
// vínculo nenhum, nunca sobrescreve um vínculo já feito na mão.
cuffBancariaRouter.post("/cuff-bancaria/empresas/:empresaId/vincular-tudo", async (req, res) => {
  const { empresaId } = req.params;
  const emprestimos = (await controlesRepo.listarEmprestimos(empresaId)).filter((e) => e.ativo && e.referenciaHistorico.trim());
  if (!emprestimos.length) {
    res.json({ vinculados: 0, mensagem: "Nenhum empréstimo ativo com texto de referência cadastrado." });
    return;
  }
  const docs = await todosDocumentos(empresaId);
  let vinculados = 0;
  const detalhes: string[] = [];

  for (const emprestimo of emprestimos) {
    const ref = emprestimo.referenciaHistorico.trim().toLowerCase();
    const parcelasJaPagas = new Set((emprestimo.pagamentos || []).map((p) => p.numero));
    let proximaParcela = 1;
    while (parcelasJaPagas.has(proximaParcela) && proximaParcela <= emprestimo.parcelas) proximaParcela++;

    for (const doc of docs) {
      for (const l of doc.lancamentos) {
        if (l.vinculoControleId) continue; // já vinculado -- nunca sobrescreve
        if (l.debCred !== "D") continue; // parcela é sempre saída
        if (!l.historico.toLowerCase().includes(ref)) continue;
        if (Math.abs(Math.abs(l.valor) - emprestimo.valorParcela) > 0.01) continue;
        if (proximaParcela > emprestimo.parcelas) break;

        await vincularParcela(empresaId, doc.contaId, doc.ano, doc.mes, l.id, emprestimo.id, proximaParcela);
        parcelasJaPagas.add(proximaParcela);
        const pagamentos = (emprestimo.pagamentos || []).filter((p) => p.numero !== proximaParcela);
        pagamentos.push({ numero: proximaParcela, dataPagamento: l.data });
        emprestimo.pagamentos = pagamentos;
        vinculados++;
        detalhes.push(`${emprestimo.apelido} — parcela ${proximaParcela}/${emprestimo.parcelas} (${l.data})`);
        while (parcelasJaPagas.has(proximaParcela) && proximaParcela <= emprestimo.parcelas) proximaParcela++;
      }
    }
    await controlesRepo.salvarEmprestimo(empresaId, emprestimo);
  }

  res.json({ vinculados, detalhes });
});
