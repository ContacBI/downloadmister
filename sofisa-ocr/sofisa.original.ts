// Parser do "Extrato por período" do Banco Sofisa (portal do cliente),
// modelo "m1". Portado do script Python `extracao/12_sofisa.py` /
// `13_sofisa.py` do sistema desktop da Micromedical (G:\Meu Drive\Micro
// oficial) -- a lógica ali é 100% regex sobre o texto "corrido" de cada
// linha (não colunas por posição, como Bradesco/Nubank), então o
// pdf.js aqui só precisa reconstruir a linha visual, não separar em
// faixas de X.
//
// Cada lançamento é uma linha "dd/mm/yy  código  histórico...  documento
// valor" (ex.: "30/01/26 00073 TITULO LIQUIDADO 0000000 154.100,00"); o
// ano vem de 2 dígitos só na linha, o ano de 4 dígitos é lido do
// cabeçalho ("Extrato por período - dd/mm/yy - ..."). Uma linha extra
// logo abaixo (sem ser ela mesma um lançamento nem um rodapé conhecido)
// é colada como complemento do histórico -- é onde vem a identificação
// da conta/CNPJ da contraparte em PIX/TED.
//
// O Sofisa lista do lançamento mais recente pro mais antigo -- inverte no
// fim pra devolver em ordem cronológica, igual todo outro parser do HUB.
// Não há "saldo anterior" explícito na grade (só um resumo "Saldo em
// conta" no topo, que não é por período) -- saldoInicial fica null, mesma
// simplificação já usada no Stone/Mercado Pago.

import type { DocumentoFinanceiro, Lancamento } from "../../domain/types.js";
import type { ParserDocumento } from "../base.js";
import { abrirPdf, type TextSpan } from "../common/pdf.js";
import { parseMoneyBr } from "../common/money.js";
import { limparDescricao, normalizarHistorico } from "../common/text.js";

const Y_TOL = 2.0;

const RE_LANCAMENTO = /^\d{2}\/\d{2}\/\d{2}\s+/;
const RE_VALOR_FIM = /(-\s*)?\d{1,3}(?:\.\d{3})*,\d{2}$/;
// "Saldo disponível em 03/07/26   6.139,95" -- fecha cada dia (é o saldo do extrato desse banco).
const RE_SALDO_DIA = /^Saldo dispon[íi]vel em (\d{2})\/(\d{2})\/(\d{2})\s+((?:-\s*)?\d{1,3}(?:\.\d{3})*,\d{2})$/i;
const RE_ANO = /Extrato por per[íi]odo\s*-\s*\d{2}\/\d{2}\/(\d{2})/i;

/** Junta os spans de uma página em linhas de texto "corridas" (agrupadas
 * por Y, ordenadas por X) -- o extrato não tem colunas fixas por posição,
 * o parser inteiro é regex sobre a linha reconstruída. */
function linhasDeTexto(spansPorPagina: TextSpan[][]): string[] {
  const linhas: string[] = [];
  for (const spansPag of spansPorPagina) {
    const agrupadas: { y: number; spans: TextSpan[] }[] = [];
    for (const span of spansPag) {
      const ln = agrupadas.find((l) => Math.abs(l.y - span.y0) <= Y_TOL);
      if (ln) ln.spans.push(span);
      else agrupadas.push({ y: span.y0, spans: [span] });
    }
    agrupadas.sort((a, b) => a.y - b.y);
    for (const ln of agrupadas) {
      const texto = limparDescricao(
        [...ln.spans].sort((a, b) => a.x0 - b.x0).map((s) => s.text).join(" ")
      );
      if (texto) linhas.push(texto);
    }
  }
  return linhas;
}

function converterValor(textoValor: string): number | null {
  const semEspaco = textoValor.replace(/\s+/g, "");
  const m = /\d{1,3}(?:\.\d{3})*,\d{2}/.exec(semEspaco);
  if (!m) return null;
  const negativo = semEspaco.startsWith("-");
  const valor = Math.abs(parseMoneyBr(m[0]));
  return negativo ? -valor : valor;
}

export class ParserSofisa implements ParserDocumento {
  tipoDocumento = "extrato_bancario" as const;
  instituicao = "sofisa";
  modelo = "m1";

  async consegueLer(buffer: Buffer): Promise<boolean> {
    const doc = await abrirPdf(buffer);
    if (doc.numPaginas === 0) return false;
    // O nome "Sofisa" só aparece na logo (imagem), nunca no texto -- a
    // assinatura é essa combinação de rótulos do resumo + do rodapé diário.
    const texto = doc.textoPorPagina.join(" ").toLowerCase();
    return texto.includes("cheque f\u00e1cil") && texto.includes("saldo dispon\u00edvel em");
  }

  async extrair(buffer: Buffer, nomeArquivo: string, empresaId: string): Promise<DocumentoFinanceiro> {
    const doc = await abrirPdf(buffer);
    const textoCompleto = doc.textoPorPagina.join(" ");
    const mAno = RE_ANO.exec(textoCompleto);
    const ano = mAno ? `20${mAno[1]}` : String(new Date().getFullYear());

    const linhas = linhasDeTexto(doc.spansPorPagina);
    const lancamentos = this.converterLinhas(linhas, ano);

    for (const lanc of lancamentos) {
      lanc.historico = normalizarHistorico(lanc.historico);
    }

    lancamentos.reverse();

    // Saldo de fechamento de cada dia. O saldo INICIAL não vem no PDF, mas sai dele: saldo do
    // primeiro dia com movimento MENOS os movimentos desse dia.
    const saldoDoDia = new Map<string, number>();
    for (const ln of linhas) {
      const m = RE_SALDO_DIA.exec(ln);
      if (!m) continue;
      const v = converterValor(m[4]);
      if (v !== null) saldoDoDia.set(`${m[1]}/${m[2]}/20${m[3]}`, v);
    }
    let saldoInicial: number | null = null;
    if (lancamentos.length > 0) {
      const primeiraData = lancamentos[0].data;
      const saldoPrimeiroDia = saldoDoDia.get(primeiraData);
      if (saldoPrimeiroDia !== undefined) {
        const movsDoDia = lancamentos.filter((l) => l.data === primeiraData).reduce((s, l) => s + l.valor, 0);
        saldoInicial = Math.round((saldoPrimeiroDia - movsDoDia) * 100) / 100;
      }
    }

    let saldoCorrente = saldoInicial ?? 0;
    for (const lanc of lancamentos) {
      saldoCorrente += lanc.valor;
      lanc.saldoCalculado = Math.round(saldoCorrente * 100) / 100;
    }
    // o saldo do dia vale pro ÚLTIMO lançamento daquele dia
    for (const [data, v] of saldoDoDia) {
      for (let i = lancamentos.length - 1; i >= 0; i--) {
        if (lancamentos[i].data === data) { lancamentos[i].saldoExtrato = v; break; }
      }
    }
    let saldoFinalExtrato: number | null = null;
    for (let i = lancamentos.length - 1; i >= 0; i--) {
      if (lancamentos[i].saldoExtrato != null) { saldoFinalExtrato = lancamentos[i].saldoExtrato as number; break; }
    }

    return {
      tipoDocumento: this.tipoDocumento,
      instituicao: this.instituicao,
      modelo: this.modelo,
      arquivoOrigem: nomeArquivo,
      empresaId,
      saldoInicial,
      saldoFinal: saldoFinalExtrato ?? (lancamentos.length > 0 ? Math.round(saldoCorrente * 100) / 100 : null),
      lancamentos,
    };
  }

  private converterLinhas(linhas: string[], ano: string): Lancamento[] {
    const lancamentos: Lancamento[] = [];

    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];
      if (!RE_LANCAMENTO.test(linha)) continue;

      const mValor = RE_VALOR_FIM.exec(linha);
      if (!mValor) continue;

      const valor = converterValor(mValor[0]);
      if (valor === null) continue;

      const dataTxt = linha.slice(0, 8); // "dd/mm/yy"
      const data = `${dataTxt.slice(0, 6)}${ano}`;

      const conteudo = linha.slice(9, mValor.index).trim();
      const partes = conteudo.split(/\s+/).filter(Boolean);
      if (partes.length < 2) continue;

      // partes[0] = código do lançamento, partes[-1] = documento -- o
      // histórico é tudo entre os dois.
      let historico = partes.slice(1, -1).join(" ").trim();

      const prox = linhas[i + 1];
      if (
        prox &&
        !RE_LANCAMENTO.test(prox) &&
        !prox.startsWith("Saldo dispon\u00edvel") &&
        !prox.startsWith("Atualizado") &&
        !prox.startsWith("Cliente:") &&
        !prox.startsWith("Extrato por per\u00edodo") &&
        !prox.startsWith("Entradas/sa\u00edd") &&
        !prox.startsWith("Data ")
      ) {
        historico = limparDescricao(`${historico} ${prox}`);
        i++;
      }

      lancamentos.push({
        data,
        historico,
        valor,
        tipoDocumento: this.tipoDocumento,
        instituicao: this.instituicao,
        modelo: this.modelo,
        tipoSaldo: "",
        tipoMovimento: valor > 0 ? "entrada" : valor < 0 ? "saida" : "outro",
      });
    }

    return lancamentos;
  }
}
