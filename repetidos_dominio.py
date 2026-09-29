"""Lista clientes que compartilham o mesmo Cód Domínio.

Uso: python3 repetidos_dominio.py clientes-cli.csv saida.csv
"""
import csv
import sys
from collections import defaultdict

with open(sys.argv[1], encoding="utf-8-sig", newline="") as f:
    cli = list(csv.reader(f, delimiter=";"))[1:]

grupos = defaultdict(list)
for c in cli:
    grupos[c[2]].append(c)

rep = {k: v for k, v in grupos.items() if len(v) > 1}
with open(sys.argv[2], "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f, delimiter=";", lineterminator="\r\n")
    w.writerow(["Cód Domínio", "Qtd clientes", "Cód", "Cliente (interno)", "Cliente Domínio", "Notas", "Saldo"])
    for k, v in sorted(rep.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        for c in v:
            w.writerow([k, len(v), c[0], c[1], c[3], c[4], c[5]])

print(f"{len(grupos)} Cód Domínio distintos; {len(rep)} repetidos, {sum(len(v) for v in rep.values())} clientes")
for k, v in sorted(rep.items(), key=lambda kv: (-len(kv[1]), kv[0])):
    print(k, len(v), [c[1][:30] for c in v] if len(v) <= 4 else "...")
