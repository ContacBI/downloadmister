# Extrator de regras do Domínio (por gravação de tela)

Lê a tela **"Configuração para Contabilizar Extrato Bancário"** do Domínio e gera as regras no formato do HUB.
Não precisa de acesso ao banco do Domínio: só da imagem da tela.

## Instalar (uma vez)
1. Python 3.10, 3.11 ou 3.12 instalado (marque "Add to PATH" na instalação).
2. Dê dois cliques em **instalar.bat**.

## Usar
1. No Domínio, abra a tela e escolha a conta do banco (ex.: 11). **A janela pode ficar do tamanho normal** (não precisa maximizar).
2. Dê dois cliques em **gravar.bat**. Escreva o nome da empresa e o código do banco. `ID da conta` é opcional.
3. Clique **Iniciar gravação** e arraste a **barra de rolagem horizontal** (embaixo da lista) **da esquerda até a direita, devagar**,
   parando um instante no começo, no meio (quando aparecer a coluna dos códigos) e no fim (histórico contábil).
4. **Lista com barra de rolagem vertical (mais de ~16 regras)?** Faça em zigue-zague: no topo, esquerda→direita; role a lista
   uns 10 a 15 linhas; direita→esquerda; role mais; esquerda→direita... até o fim da lista. Deixe umas 3 linhas repetidas
   entre um bloco e o seguinte.
5. Clique **Parar e extrair**. Leva alguns minutos (o programa lê por OCR, no seu computador, sem internet).
6. A pasta `saidas\<empresa>_bancoNN` abre com:
   - `conferencia_<empresa>.csv` — **a lista lida; confira contra a tela do Domínio**, principalmente a coluna dos códigos.
     Linhas com `Conferir? = SIM` são as duvidosas.
   - `regras-<empresa>-bancoNN.json` — para importar no HUB ("Ambos" do Domínio vira natureza `AMBOS`).
   - `regras-<empresa>-bancoNN-AMBOS-expandido.json` — alternativa: cada "Ambos" vira duas regras (PAGAMENTO + RECEBIMENTO). Use se o HUB não aceitar `AMBOS`.
   - `colunas_detectadas.png` — só na janela maximizada; serve para diagnóstico.

Já tem um vídeo gravado por outro programa? Use **"Ler um vídeo já gravado..."** ou, pelo prompt:

    py extrair_regras.py GRAVACAO.mp4 --empresa "NOME" --banco 11

(Se você maximizar a janela, as 6 colunas aparecem juntas e basta rolar a lista para baixo; o programa detecta sozinho os dois casos.)

## Limites (leia)
- Os textos saem **sem acento** (por escolha). Números e códigos são lidos por OCR: **sempre confira o CSV**.
- Se o programa avisar que "trechos não se encontram", faltou linha entre dois blocos: grave de novo, rolando mais devagar.
- **Teste com o seu vídeo real** (janela normal, 42 regras do banco 11 da JANA FAVORETO): ordem e quantidade 42/42,
  Tipo 42/42, **Código 42/42**, Parte do histórico 39/42, Histórico contábil 30/42 (erros de espaço e de letra,
  como `F 1 P`, `DlARISTA`, `Fécil`). Por isso o CSV de conferência é obrigatório.
- Ainda **não testado**: o gravador de tela (a janelinha) num Windows de verdade e a janela maximizada real.
