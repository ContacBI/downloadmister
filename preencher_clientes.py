"""Preenche nome completo e Cód Domínio do cliente nas listagens de notas/parcelas.

Uso: python3 preencher_clientes.py clientes-cli.csv arquivo.csv saida.csv [arquivo2.csv saida2.csv ...]

O nome resumido das listagens não coincide com o do cadastro (cli), então o
vínculo é feito por (quantidade de notas, saldo total) a partir do 1º arquivo
de listagem (notas). O que sobrar é ligado pelo prefixo do nome (20 caracteres).
As colunas "Cliente completo" e "Cód Domínio" entram logo após "Cliente".
"""
import csv
import sys
from collections import defaultdict


def num(s):
    s = s.strip().replace("\xa0", "")
    if s in ("", "-"):
        return 0.0
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    return float(s)


def ler(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f, delimiter=";"))
    return rows[0], rows[1:]


def vincular(cli, nota_rows, i_valor):
    tot = defaultdict(lambda: [0, 0.0])
    for r in nota_rows:
        tot[r[0]][0] += 1
        tot[r[0]][1] += num(r[i_valor])

    cands = defaultdict(list)
    for short, (n, saldo) in tot.items():
        cands[(n, round(saldo, 2))].append(short)

    mapa, usados, sobra = {}, set(), []
    for c in cli:
        opts = [o for o in cands.get((int(c[4]), round(num(c[5]), 2)), []) if o not in usados]
        if len(opts) > 1:
            opts = [o for o in opts if c[1].upper().startswith(o.upper())] or opts
        if len(opts) == 1:
            mapa[opts[0]] = c
            usados.add(opts[0])
        else:
            sobra.append(c)

    # sobras: prefixo do nome, para clientes cujo saldo/notas mudaram
    pendentes = set(tot) - usados
    for c in sobra:
        opts = [o for o in pendentes if c[1].upper().startswith(o.upper())]
        if len(opts) == 1:
            mapa[opts[0]] = c
            pendentes.discard(opts[0])
            print(f"  vínculo por nome (saldo mudou): {opts[0]} -> {c[1]}")
    return mapa, sorted(pendentes)


def main(cli_path, *pares):
    _, cli = ler(cli_path)
    arquivos = list(zip(pares[0::2], pares[1::2]))

    header, rows = ler(arquivos[0][0])
    mapa, sem_vinculo = vincular(cli, rows, header.index("Valor"))

    for entrada, saida in arquivos:
        header, rows = ler(entrada)
        with open(saida, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f, delimiter=";", lineterminator="\r\n")
            w.writerow([header[0], "Cliente completo", "Cód Domínio", *header[1:]])
            for r in rows:
                c = mapa.get(r[0])
                w.writerow([r[0], c[1] if c and c[0] else "", c[2] if c else "", *r[1:]])

    sem_nome = sorted(k for k, c in mapa.items() if not c[0])
    print(f"clientes: {len(mapa) + len(sem_vinculo)} | com nome completo: {len(mapa) - len(sem_nome)}")
    print(f"sem nome completo no cadastro ({len(sem_nome)}): {sem_nome}")
    print(f"sem vínculo ({len(sem_vinculo)}): {sem_vinculo}")


if __name__ == "__main__":
    main(*sys.argv[1:])
