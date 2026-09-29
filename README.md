# downloadmister

Baixa as regras de todas as empresas do Mister Contador (o site não tem exportação).

## Como rodar `baixar-regras.js`

1. Entre no Mister Contador e abra **Regras** de qualquer empresa.
2. Aperte **F12** e abra a aba **Console**.
3. Abra `baixar-regras.js`, copie o arquivo inteiro e cole no Console. Aperte Enter.
   Se o Chrome pedir, digite `allow pasting` e cole de novo.
4. Quando aparecer o aviso, **clique numa página da lista** (ex.: página 2). O script usa o próprio acesso do navegador, então nada de senha ou token é digitado.
5. Na caixa que abrir, digite os **IDs das empresas** separados por vírgula (ex.: `9,12,15`). Deixe vazio para baixar todas as empresas ativas (o script lista sozinho).
   Teste primeiro só com uma empresa.
6. Ao final, o Chrome baixa **um arquivo ZIP** (`regras-mister-AAAA-MM-DD.zip`). Extraia e você terá:
   - uma **pasta por empresa** (`NOME DA EMPRESA - ID`), com a planilha Excel das regras dela (`.xlsx` formatada: cabeçalho colorido, filtros, primeira linha congelada, D em vermelho e C em verde);
   - `_empresas.xlsx`: lista das empresas com CNPJ, cidade, quantidade de regras e a aba "Todos os campos" (tudo o que o sistema informa de cada empresa, para procurar dados extras como quem criou);
   - `todas-as-regras.json`: todos os dados de todas as regras, para importar em outro sistema.
   Empresas sem nenhuma regra não geram pasta.

Para parar antes: no Console, `window.__mrParar = true`. O que já foi baixado é salvo.

## Segurança

- Só faz leituras (GET). Não exclui nem altera nenhuma regra.
- Faz uma pausa curta entre as chamadas e tenta de novo se o servidor pedir.
- Se o acesso expirar no meio, faça login de novo e rode outra vez.
- Não guarde token nem senha neste repositório.
