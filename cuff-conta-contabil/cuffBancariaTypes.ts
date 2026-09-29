// Tipos do módulo "Conciliação Bancária" do Grupo Cuff -- ver comentário
// completo em CUFF_BANCARIA_DIR (config.ts). Diferente do MIB: só espelha o
// extrato do Bling, não compara contra relatório contábil nenhum -- por isso
// não existe VinculoCuff (casamento 1:1 extrato x relatório) nem
// contaContabil (não há exportação contábil/Domínio pro Cuff ainda). O que
// existe de "vínculo" aqui é só a ligação lançamento-do-banco <-> parcela de
// Empréstimo/Licença (Controles), pra dar baixa -- ver vincularParcela em
// cuffBancariaRepository.ts.

// Uma conta do Bling (GET /contas-contabeis) que o usuário escolheu
// acompanhar pra uma empresa específica do Hub. `idContaFinanceira` é o ID
// real no Bling (usado no filtro de GET /caixas); `descricaoBling` é o nome
// que o Bling devolveu no momento do cadastro (ex: "APPMAX - CJ"), só pra
// mostrar de referência -- `apelido` é o que o usuário realmente vê na tela.
export interface ContaBancariaCuff {
  id: string; // gerado localmente (slug), não é o idContaFinanceira
  empresaId: string; // id do registro central (HUB_DIR)
  idContaFinanceira: number;
  descricaoBling: string;
  tipo: string; // "banco" | "caixa" | "conta-bancaria" | "integracao-pagamento" (ver ContasFinanceirasDadosBasicosDTO no Bling)
  apelido: string;
  criadoEm: string;
  // Campos livres, mesmo padrão do ContaBancariaMib (contaSistema/
  // contaSaldoCredor) -- editáveis pelo usuário no "Gerenciar", ainda sem
  // uma exportação contábil que os consuma automaticamente (ver comentário
  // no topo do arquivo), mas ficam guardados pra quando existir.
  contaSistema?: string;
  contaSaldoCredor?: string;
  // Busca automática periódica (mesmo padrão de ContaBancariaMib.
  // superlogicaAutoHoras, ver jobs/cuffBancariaAutoSync.ts): de quantas em
  // quantas HORAS tentar buscar sozinho o mês atual no Bling, sem precisar
  // clicar em "Buscar do Bling" -- 0/null/undefined = desligado.
  blingAutoHoras?: number | null;
  blingUltimaBuscaEm?: string | null; // ISO datetime -- última tentativa (sucesso, erro ou pulo)
  blingUltimoResultado?: string | null; // texto curto pra mostrar em Configurações
}

// Um lançamento de "Caixas e Bancos" do Bling (GET /caixas), já normalizado
// pros campos que a tela usa -- ver CaixasBancosItemLancamentoDTO no
// openapi do Bling. IMPORTANTE (confirmado ao vivo contra dados reais,
// 08/09/2026): o que a TELA do Bling chama de "Categoria" é o campo
// `descricao` da API (ex: "Vendas", "Impostos", "Aluguel"), e o que a tela
// chama de "Histórico" é o campo `observacoes` (o texto livre de verdade,
// ex: "PIS E COFINS CUFF 05/2026 - Baixa por conciliação") -- nomes
// contraintuitivos, mas é assim que a API devolve. `historico` é a base
// usada pelas Regras e por `referenciaHistorico` dos Controles (empréstimos).
export interface LancamentoCuff {
  id: string; // id do lançamento no Bling
  data: string; // AAAA-MM-DD
  valor: number;
  debCred: "D" | "C"; // D = débito/saída, C = crédito/entrada
  situacao: string;
  categoria: string; // campo `descricao` do Bling
  historico: string; // campo `observacoes` do Bling
  contatoNome?: string;
  contatoCnpj?: string;
  origemId?: number;
  // Preenchido pela engine de Regras (ver RegraCuff) quando alguma regra
  // ativa bate no `historico` -- só um rótulo livre pra filtrar/agrupar na
  // Central de Lançamentos, não é conta contábil (Cuff não exporta pra
  // nenhum sistema contábil ainda).
  categoriaPropria?: string | null;
  // Copiado (sem resolver os atalhos <MES ATUAL> etc.) da regra que bateu,
  // se ela tiver um -- quem resolve pro texto final é o cliente
  // (substituirTokensHistorico), baseado na DATA do próprio lançamento.
  historicoPadrao?: string | null;
  // Conta contábil (Cód Domínio) da contrapartida, copiada da regra que bateu.
  contaContabil?: string | null;
  // Vínculo com uma parcela de Empréstimo/Licença (Controles) -- ver
  // vincularParcela/desvincularParcela. null/undefined = sem vínculo.
  vinculoControleId?: string | null;
  vinculoParcela?: number | null;
}

// Lançamentos já buscados e salvos de 1 conta + 1 mês (cache local, pra não
// precisar rebuscar no Bling toda vez que o usuário abre a tela).
export interface DocumentoCuff {
  empresaId: string;
  contaId: string;
  ano: number;
  mes: number; // 1-12
  lancamentos: LancamentoCuff[];
  buscadoEm: string; // ISO -- pra mostrar "atualizado em..." na tela
}

// Regra de categorização -- só organizacional (ver categoriaPropria acima),
// mesma estrutura básica de RegraMib (texto/modo/onde não existe aqui: só
// bate contra `historico`, que já é o único campo de texto livre do Bling).
export type ModoRegraCuff = "contem" | "comeca" | "termina" | "exato" | "regex";

export interface RegraCuff {
  id: string;
  texto: string;
  modo: ModoRegraCuff;
  tipo: "" | "D" | "C"; // "" = qualquer
  categoriaPropria: string;
  // Valor exato em módulo (opcional): a regra só bate se |valor| do lançamento for esse
  // -- sozinho (texto vazio) ou junto com o texto. Pedido do Izaias, 21/09/2026.
  valor?: number | null;
  // Texto que SUBSTITUI o histórico do lançamento quando essa regra bate
  // (mesmo padrão de RegraMib.historicoPadrao) -- opcional, aceita os
  // atalhos <MES ATUAL>/<MES ATUAL ABREV>/<MES ANTERIOR>/<MES ANTERIOR
  // ABREV>/<DATA ATUAL>/<ANO ATUAL>, resolvidos pela DATA do lançamento.
  historicoPadrao?: string;
  // Conta contábil (Cód Domínio) da contrapartida -- opcional, só dígitos.
  contaContabil?: string;
  // Restringe a regra a UMA conta bancária específica (id de
  // ContaBancariaCuff) -- null/undefined = vale pra todas as contas da empresa.
  contaId?: string | null;
  ativa: boolean;
  ordem: number;
}
