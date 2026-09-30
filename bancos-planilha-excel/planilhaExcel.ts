// Parser da "Planilha Excel" (modelo próprio, não é de banco nenhum) --
// via de escape pra quando não existe (ainda) um parser pro banco de
// verdade, ou pra lançamentos que simplesmente não vêm de um extrato em
// PDF (ajustes manuais, um caixinha, etc). O usuário baixa um modelo
// pronto (rota /api/modelos/planilha-excel.xlsx, ver routes/conversao.ts),
// preenche uma linha por lançamento (Data / Histórico / Valor) e importa
// de volta aqui, exatamente como se fosse mais um "banco".
//
// `consegueLer` procura por um cabeçalho com essas 3 colunas em QUALQUER
// aba do arquivo (o modelo tem uma aba "Instruções" antes da aba
// "Lançamentos", então não dá pra assumir que é sempre a primeira aba).

import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { DocumentoFinanceiro, Lancamento } from "../../domain/types.js";
import type { ParserDocumento } from "../base.js";
import { parseMoneyBr } from "../common/money.js";
import { normalizarHistorico } from "../common/text.js";

const NOMES_COLUNA = {
  data: ["data"],
  historico: ["historico", "histórico", "descricao", "descrição"],
  valor: ["valor"],
};

// O ExcelJS quebra ("Cannot read properties of undefined (reading 'comments')") em planilhas com COMENTÁRIOS de célula
// gravados por outros programas (ex.: o modelo editado por um script Python/openpyxl grava em xl/comments/comment1.xml).
// Os comentários não servem pra nada aqui: se a leitura normal falhar, tira comentários/desenhos antigos do .xlsx e tenta de novo.
async function semComentarios(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  for (const nome of Object.keys(zip.files)) {
    if (/^xl\/comments/i.test(nome) || /^xl\/drawings\/.*vml/i.test(nome) || /\.vml$/i.test(nome)) {
      zip.remove(nome);
    } else if (/^xl\/worksheets\/_rels\/.+\.rels$/i.test(nome)) {
      const xml = await zip.file(nome)!.async("string");
      zip.file(nome, xml.replace(/<Relationship\b[^>]*\/(?:comments|vmlDrawing)"[^>]*\/>/gi, "").replace(/<Relationship\b[^>]*Type="[^"]*(?:comments|vmlDrawing)"[^>]*\/>/gi, ""));
    } else if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(nome)) {
      const xml = await zip.file(nome)!.async("string");
      zip.file(nome, xml.replace(/<legacyDrawing\b[^>]*\/>/gi, ""));
    } else if (nome === "[Content_Types].xml") {
      const xml = await zip.file(nome)!.async("string");
      zip.file(nome, xml.replace(/<Override\b[^>]*PartName="\/xl\/(?:comments|drawings\/[^"]*vml)[^"]*"[^>]*\/>/gi, ""));
    }
  }
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

async function carregarPlanilha(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as any);
    return wb;
  } catch (erroOriginal) {
    let limpo: Buffer;
    try {
      limpo = await semComentarios(buffer);
    } catch {
      throw erroOriginal; // nem abre como zip -- não é um .xlsx
    }
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(limpo as any);
    return wb2;
  }
}

function normalizarNomeColuna(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

interface ColunasAchadas {
  linhaCabecalho: number;
  data: number;
  historico: number;
  valor: number;
}

function acharCabecalho(ws: ExcelJS.Worksheet): ColunasAchadas | null {
  const maxLinhas = Math.min(ws.rowCount, 15);
  for (let r = 1; r <= maxLinhas; r++) {
    const row = ws.getRow(r);
    let colData = -1, colHistorico = -1, colValor = -1;
    for (let c = 1; c <= Math.max(row.cellCount, 1); c++) {
      const nome = normalizarNomeColuna(row.getCell(c).value);
      if (colData === -1 && NOMES_COLUNA.data.includes(nome)) colData = c;
      else if (colHistorico === -1 && NOMES_COLUNA.historico.includes(nome)) colHistorico = c;
      else if (colValor === -1 && NOMES_COLUNA.valor.includes(nome)) colValor = c;
    }
    if (colData !== -1 && colHistorico !== -1 && colValor !== -1) {
      return { linhaCabecalho: r, data: colData, historico: colHistorico, valor: colValor };
    }
  }
  return null;
}

function celulaParaData(v: unknown): string | null {
  if (v instanceof Date) {
    // ExcelJS lê datas em UTC -- usa os componentes UTC pra não perder um
    // dia por causa de fuso horário.
    const dd = String(v.getUTCDate()).padStart(2, "0");
    const mm = String(v.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = v.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  if (typeof v === "number") {
    // serial de data do Excel (dias desde 1899-12-30)
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      return `${dd}/${mm}/${d.getUTCFullYear()}`;
    }
  }
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (m) return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3]}`;
  }
  return null;
}

function celulaParaValor(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "result" in (v as any)) {
    const r = (v as any).result;
    if (typeof r === "number") return r;
  }
  if (typeof v === "string" && v.trim()) {
    const n = parseMoneyBr(v);
    return n || (v.trim() === "0" ? 0 : n);
  }
  return null;
}

function celulaParaTexto(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && v !== null && "text" in (v as any)) return String((v as any).text ?? "");
  if (typeof v === "object" && v !== null && "result" in (v as any)) return String((v as any).result ?? "");
  if (v instanceof Date) return "";
  return String(v);
}

export class ParserPlanilhaExcel implements ParserDocumento {
  tipoDocumento = "extrato_bancario" as const;
  instituicao = "planilha_excel";
  modelo = "m1";

  async consegueLer(buffer: Buffer): Promise<boolean> {
    try {
      const wb = await carregarPlanilha(buffer);
      for (const ws of wb.worksheets) {
        if (acharCabecalho(ws)) return true;
      }
      return false;
    } catch {
      return false; // não é nem um .xlsx válido
    }
  }

  async extrair(buffer: Buffer, nomeArquivo: string, empresaId: string): Promise<DocumentoFinanceiro> {
    const wb = await carregarPlanilha(buffer);

    let planilha: ExcelJS.Worksheet | null = null;
    let colunas: ColunasAchadas | null = null;
    for (const ws of wb.worksheets) {
      const c = acharCabecalho(ws);
      if (c) { planilha = ws; colunas = c; break; }
    }
    if (!planilha || !colunas) {
      throw new Error('Não encontrei uma aba com as colunas "Data", "Histórico" e "Valor".');
    }

    const lancamentos: Lancamento[] = [];
    for (let r = colunas.linhaCabecalho + 1; r <= planilha.rowCount; r++) {
      const row = planilha.getRow(r);
      const dataTxt = celulaParaData(row.getCell(colunas.data).value);
      const historicoTxt = celulaParaTexto(row.getCell(colunas.historico).value);
      const valorNum = celulaParaValor(row.getCell(colunas.valor).value);

      // linha do exemplo do modelo, ou linha em branco -- pula sem erro.
      if (!dataTxt && !historicoTxt && valorNum === null) continue;
      if (!dataTxt || valorNum === null) continue;

      lancamentos.push({
        data: dataTxt,
        historico: normalizarHistorico(historicoTxt),
        valor: valorNum,
        tipoDocumento: this.tipoDocumento,
        instituicao: this.instituicao,
        modelo: this.modelo,
        tipoSaldo: "",
        tipoMovimento: valorNum > 0 ? "entrada" : valorNum < 0 ? "saida" : "outro",
      });
    }

    let saldoCorrente = 0;
    for (const lanc of lancamentos) {
      saldoCorrente = Math.round((saldoCorrente + lanc.valor) * 100) / 100;
      lanc.saldoCalculado = saldoCorrente;
    }

    return {
      tipoDocumento: this.tipoDocumento,
      instituicao: this.instituicao,
      modelo: this.modelo,
      arquivoOrigem: nomeArquivo,
      empresaId,
      // não tem "saldo inicial" de verdade nesse modelo -- é só uma lista
      // de lançamentos digitados, sem extrato de banco por trás.
      saldoInicial: null,
      saldoFinal: lancamentos.length ? saldoCorrente : null,
      lancamentos,
    };
  }
}
