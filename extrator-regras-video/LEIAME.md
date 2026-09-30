# Extrator de regras do Domínio (por gravação de tela)

Lê a tela **"Configuração para Contabilizar Extrato Bancário"** do Domínio e gera as regras no formato do HUB.
Não precisa de acesso ao banco do Domínio: só da imagem da tela.

## Instalar (uma vez)
1. Python 3.10, 3.11 ou 3.12 instalado (marque "Add to PATH" na instalação).
2. Dê dois cliques em **instalar.bat**.

## Usar
1. No Domínio, abra a tela e **maximize a janela** (botão do meio, no canto superior direito) — assim as 6 colunas aparecem juntas.
2. Dê dois cliques em **gravar.bat**. Escreva o nome da empresa e o código do banco (ex.: 11). `ID da conta` é opcional.
3. Clique **Iniciar gravação** e **role a lista devagar, de cima para baixo**: uns 10 a 15 linhas por vez, parando um instante. Deixe umas 3 linhas repetidas entre uma tela e a seguinte.
4. Clique **Parar e extrair**. Leva alguns minutos (o programa lê cada tela por OCR).
5. A pasta `saidas\<empresa>_bancoNN` abre com:
   - `conferencia_<empresa>.csv` — **a lista lida; confira contra a tela do Domínio**, principalmente a coluna dos códigos. Linhas com `Conferir? = SIM` são as duvidosas.
   - `regras-<empresa>-bancoNN.json` — para importar no HUB ("Ambos" do Domínio vira natureza `AMBOS`).
   - `regras-<empresa>-bancoNN-AMBOS-expandido.json` — alternativa: cada "Ambos" vira duas regras (PAGAMENTO + RECEBIMENTO). Use se o HUB não aceitar `AMBOS`.
   - `colunas_detectadas.png` — a tela com as colunas marcadas por linhas coloridas (serve para diagnosticar).

Já tem um vídeo gravado por outro programa? Use **"Ler um vídeo já gravado..."** ou, pelo prompt:

    py extrair_regras.py GRAVACAO.mp4 --empresa "NOME" --banco 11

## Limites (leia)
- Os textos saem **sem acento** (por escolha). Números e códigos são lidos por OCR: **sempre confira o CSV**.
- Se o programa avisar "sem sobreposição", faltou linha entre duas telas: grave de novo rolando mais devagar.
- Se as colunas saírem trocadas, abra `colunas_detectadas.png`; dá para ajustar com `--colunas codigo_x0,contra_x0,hist_x0,fim_x`.
- **Estado dos testes:** com telas sintéticas (janela larga, 42 regras): ordem e quantidade 42/42, Tipo 100%, Código 98–100%, Parte do histórico ~88%; o Histórico contábil vem com as letras certas, mas **os espaços entre palavras falham com frequência** ("PAGAMENTOFORNECEDOR...") — por isso quase todas as linhas saem com `Conferir? = SIM`. Com imagens reais do Domínio (janela pequena) a leitura da coluna "Parte do histórico" acertou 16 de 16 linhas.
- **Ainda não testado:** a janela maximizada real do Domínio, e o gravador de tela (a janelinha) num Windows de verdade. Teste primeiro com uma empresa pequena e me mande o `colunas_detectadas.png` e o CSV.
- A leitura do vídeo leva de 4 a 8 minutos (o OCR roda no computador, sem internet).
