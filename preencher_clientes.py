"""Preenche nome completo e código do cliente na listagem de notas.

Uso: python3 preencher_clientes.py clientes-cli.csv clientes-nota.csv saida.csv

O nome resumido da listagem de notas não coincide com o do arquivo de
clientes, então o vínculo é feito por (quantidade de notas, saldo total).
Casos ambíguos são desempatados pelo total vencido e, por fim, pelo prefixo
do nome; o que continuar ambíguo ou sem código fica em branco e é avisado.
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


def main(cli_path, nota_path, out_path):
    with open(cli_path, encoding="utf-8-sig", newline="") as f:
        cli = list(csv.reader(f, delimiter=";"))[1:]
    with open(nota_path, encoding="utf-8-sig", newline="") as f:
        nota = list(csv.reader(f, delimiter=";"))
    header, rows = nota[0], nota[1:]

    tot = defaultdict(lambda: [0, 0.0, 0.0])
    for r in rows:
        t = tot[r[0]]
        t[0] += 1
        t[1] += num(r[6])
        t[2] += num(r[7])

    cands = defaultdict(list)
    for short, (n, saldo, venc) in tot.items():
        cands[(n, round(saldo, 2))].append((short, round(venc, 2)))

    # cada linha do arquivo de clientes reivindica um nome resumido
    mapa, problemas = {}, []
    for c in cli:
        cod, nome = c[0], c[1]
        opts = cands.get((int(c[4]), round(num(c[5]), 2)), [])
        if len(opts) > 1:
            opts = [o for o in opts if o[1] == round(num(c[6]), 2)] or opts
        if len(opts) > 1:
            opts = [o for o in opts if nome.upper().startswith(o[0].upper())] or opts
        if len(opts) != 1 or opts[0][0] in mapa:
            problemas.append(nome)
            continue
        mapa[opts[0][0]] = (nome if cod else "", cod)

    header[1], header[2] = "Cliente completo", "Cód"
    with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";", lineterminator="\r\n")
        w.writerow(header)
        for r in rows:
            nome, cod = mapa.get(r[0], ("", ""))
            r[1], r[2] = nome, cod
            w.writerow(r)

    sem_cod = sorted({k for k, v in mapa.items() if not v[1]})
    nao_achou = sorted(set(tot) - set(mapa))
    print(f"clientes na listagem: {len(tot)} | com código: {len(tot) - len(sem_cod) - len(nao_achou)}")
    print(f"sem código no cadastro ({len(sem_cod)}): {sem_cod}")
    print(f"sem vínculo ({len(nao_achou)}): {nao_achou}")
    print(f"linhas do cadastro não vinculadas: {problemas}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
