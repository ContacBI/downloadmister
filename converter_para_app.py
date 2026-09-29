"""Converte as regras baixadas do Mister Contador para os JSONs de empresa do app.

Uso:
  python3 converter_para_app.py todas-as-regras.json saida/ [--existentes arquivos/] [--numeros numeros.csv]

  todas-as-regras.json  arquivo gerado pelo baixar-regras.js (dentro do ZIP)
  saida/                pasta de saída: saida/novas (empresas novas) e saida/atualizadas (já existiam
                        no app; o arquivo tem o mesmo nome do original), um JSON por empresa
  --existentes          pasta com JSONs de empresas que já existem no app. Se o CNPJ bater, o
                        arquivo é reaproveitado (id, número, contas e lançamentos ficam) e só as
                        regras que ainda não existem são acrescentadas.
  --numeros             CSV "cnpj;numero" com o número da empresa no app (para empresas novas)
  --bancos              CSV "nome_mister;id_app;nome_app": qual banco do app corresponde a cada banco do Mister
  --beneficiario        converter (padrão) ou ignorar as regras do tipo BENEFICIARIO

Mapeamento (Mister -> app):
  Descrição da regra (regDescricao)        -> historico (modo CONTEM)
  Histórico (regHistorico)                 -> historicoPadrao, só se "Histórico do extrato" = não
  D/C: D -> PAGAMENTO, C -> RECEBIMENTO
  Conta (conConta)                         -> conta
  Agência bancária da regra                -> contaId (conta bancária da empresa); "Todas" -> null
Um relatório (relatorio-conversao.csv) lista tudo o que precisa de atenção.
"""
import argparse
import csv
import glob
import json
import os
import random
import re
import time
import unicodedata
import uuid

TIPO_DOC = "extrato_bancario"
BANCOS = [  # (nome no Mister, sem acento e minúsculo) -> (id do app, nome no app)
    # os ids seguem os nomes dos modelos da pasta modelos/ (ex.: sicoob_m1__extrato_bancario.png)
    ("banco do brasil", ("banco_do_brasil", "Banco do Brasil")),
    ("bradesco", ("bradesco", "Bradesco")),
    ("inter", ("inter", "Banco Inter")),
    ("mercado pago", ("mercado_pago", "Mercado Pago")),
    ("nubank", ("nubank", "Nubank")),
    ("nu pagamentos", ("nubank", "Nubank")),
    ("olist", ("olist", "Olist (Celcoin)")),
    ("santander", ("santander", "Santander")),
    ("sicredi", ("sicredi", "Sicredi")),
    ("sicoob", ("sicoob", "Sicoob")),
    ("cred crea", ("credcrea", "Cred Crea")),
    ("credcrea", ("credcrea", "Cred Crea")),
    ("itau", ("itau", "Itaú")),
    ("caixa", ("caixa", "Caixa Econômica Federal")),
    ("c6", ("c6", "Banco C6")),
    ("sofisa", ("sofisa", "Banco Sofisa")),
    ("safra", ("safra", "Banco Safra")),
    ("stone", ("stone", "Stone")),
    ("cora", ("cora", "Cora")),
    ("cresol", ("cresol", "Cresol")),
    ("daycoval", ("daycoval", "Daycoval")),
    ("infinitepay", ("infinitypay", "InfinitePay")),
    ("infinity pay", ("infinitypay", "InfinitePay")),
    ("pagbank", ("pagbank", "PagBank")),
    ("pagseguro", ("pagbank", "PagBank")),
    ("sisprime", ("sisprime", "Sisprime")),
    ("xp investimentos", ("xp", "XP")),
    ("banco xp", ("xp", "XP")),
]
SEM_BANCO = ("planilha_excel", "Planilha Excel (modelo próprio)")


def norm(t):
    t = unicodedata.normalize("NFD", str(t or "")).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", t).strip().lower()


def base36(n):
    d = "0123456789abcdefghijklmnopqrstuvwxyz"
    s = ""
    while n:
        n, r = divmod(n, 36)
        s = d[r] + s
    return s or "0"


def novo_id_regra():
    rnd = "".join(random.choice("0123456789abcdefghijklmnopqrstuvwxyz") for _ in range(8))
    return f"id-{base36(int(time.time() * 1000))}-{rnd}"


def so_digitos(v):
    return re.sub(r"\D", "", str(v or ""))


def banco_do_app(nome_mister, tabela):
    n = norm(nome_mister)
    if n in tabela:
        return tabela[n]
    for trecho, destino in BANCOS:
        if re.search(r"\b" + re.escape(trecho) + r"\b", n):
            return destino
    return None


def conta_banco_de(ag):
    num, dig = str(ag.get("ageNumero") or "").strip(), str(ag.get("ageDigito") or "").strip()
    return f"{num}-{dig}" if dig else num


def chave_regra(r):
    return (norm(r["historico"]), r["modo"], r["natureza"], str(r["conta"]), norm(r["historicoPadrao"]), r["contaId"])


def carregar_existentes(pasta):
    saida = {}
    for f in glob.glob(os.path.join(pasta, "*.json")):
        try:
            d = json.load(open(f, encoding="utf-8"))
            saida[so_digitos(d["cnpj"])] = d
        except Exception:
            pass
    return saida


def converter_empresa(cnpj, regras_mister, existente, numeros, tabela_bancos, beneficiario, rel):
    p0 = regras_mister[0].get("parceiro") or {}
    if existente:
        emp = existente
        emp.setdefault("regras", [])
        emp.setdefault("contasBancarias", [])
    else:
        emp = {"id": str(uuid.uuid4()), "numero": numeros.get(cnpj, ""), "cnpj": cnpj,
               "nome": p0.get("parRazaosocial") or "", "contasBancarias": [], "regras": [], "lancamentos": []}
    aviso, avisados, ignoradas = [], set(), {}
    if not emp["numero"]:
        aviso.append("sem número da empresa")

    # contas bancárias: reaproveita a que já existe (mesma conta do sistema + conta do banco) ou cria
    def conta_do_app(ag):
        sistema = str((ag.get("conta") or {}).get("conConta", ""))
        cb = conta_banco_de(ag)
        for c in emp["contasBancarias"]:  # a conta do sistema (código contábil) identifica a conta
            if c["contaSistema"] == sistema:
                return c["id"]
        nome = (ag.get("banco") or {}).get("banDescricao") or ag.get("ageDescricao") or ""
        destino = banco_do_app(nome, tabela_bancos)
        if destino is None:
            destino = SEM_BANCO
            if nome not in avisados:
                avisados.add(nome)
                aviso.append(f"banco sem equivalente no app ({nome}): usado {SEM_BANCO[0]}")
        bid, bnome = destino
        cid = str(uuid.uuid4())
        emp["contasBancarias"].append({"id": cid, "tipoDocumento": TIPO_DOC, "bancoId": bid,
                                       "bancoNome": bnome, "contaBanco": cb, "contaSistema": sistema})
        return cid

    existentes = {chave_regra(r) for r in emp["regras"]}
    por_desc = {}
    novas = duplicadas = n_benef = 0
    for m in regras_mister:
        tipo = m.get("tipoRegra")
        if tipo == "BENEFICIARIO":
            if beneficiario == "ignorar":
                ignoradas[tipo] = ignoradas.get(tipo, 0) + 1
                continue
            n_benef += 1
        elif tipo != "HISTORICO":
            ignoradas[tipo] = ignoradas.get(tipo, 0) + 1
            continue
        c = m.get("conta") or {}
        if c.get("conConta") in (None, ""):
            aviso.append(f"regra sem conta: {m.get('regDescricao')}")
            continue
        ag = m.get("agenciabancaria")
        r = {
            "id": novo_id_regra(), "ativo": True,
            "historico": str(m.get("regDescricao") or "").strip(),
            "historicoPadrao": "" if m.get("manterHistorico") else str(m.get("regHistorico") or "").strip(),
            "modo": "CONTEM", "natureza": "PAGAMENTO" if m.get("debito") else "RECEBIMENTO",
            "conta": str(c["conConta"]), "contaId": conta_do_app(ag) if ag else None, "valor": None,
        }
        k = chave_regra(r)
        if k in existentes:
            duplicadas += 1
            continue
        existentes.add(k)
        emp["regras"].append(r)
        novas += 1
        por_desc.setdefault((norm(r["historico"]), r["natureza"], r["contaId"]), set()).add(r["conta"])
    for tipo, q in ignoradas.items():
        aviso.append(f"{q} regra(s) ignorada(s) do tipo {tipo}")
    conflitos = [f"{d[0]} ({d[1]}): contas {sorted(c)}" for d, c in por_desc.items() if len(c) > 1]
    if conflitos:
        aviso.append("mesma descrição e banco com contas diferentes: " + "; ".join(conflitos[:5]))
    rel.append({"empresa": emp["nome"], "cnpj": cnpj, "arquivo": ("atualizadas/" if existente else "novas/") + emp["id"] + ".json",
                "situacao": "existente (regras acrescentadas)" if existente else "nova",
                "regras_no_mister": len(regras_mister), "regras_novas": novas,
                "das_quais_beneficiario": n_benef, "duplicadas_ignoradas": duplicadas, "atencao": " | ".join(aviso)})
    return emp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mister")
    ap.add_argument("saida")
    ap.add_argument("--existentes")
    ap.add_argument("--numeros")
    ap.add_argument("--bancos", help='CSV "nome_mister;id_app;nome_app" (ajusta o banco de cada conta)')
    ap.add_argument("--beneficiario", choices=["converter", "ignorar"], default="converter",
                    help="regras do tipo BENEFICIARIO: converter como 'histórico contém o nome' (padrão) ou ignorar")
    a = ap.parse_args()

    regras = json.load(open(a.mister, encoding="utf-8"))
    existentes = carregar_existentes(a.existentes) if a.existentes else {}
    numeros = {}
    if a.numeros:
        with open(a.numeros, encoding="utf-8-sig", newline="") as f:
            for row in csv.reader(f, delimiter=";"):
                if len(row) >= 2 and so_digitos(row[0]):
                    numeros[so_digitos(row[0])] = row[1].strip()

    tabela_bancos = {}
    if a.bancos:
        with open(a.bancos, encoding="utf-8-sig", newline="") as f:
            for row in csv.reader(f, delimiter=";"):
                if len(row) >= 3 and row[1].strip() and norm(row[0]) != "nome_mister":
                    tabela_bancos[norm(row[0])] = (row[1].strip(), row[2].strip())

    por_empresa = {}
    for r in regras:
        por_empresa.setdefault(so_digitos((r.get("parceiro") or {}).get("parCnpjcpf")), []).append(r)
    por_empresa.pop("", None)

    os.makedirs(a.saida, exist_ok=True)
    rel = []
    for cnpj, lista in por_empresa.items():
        ja_existe = existentes.get(cnpj) is not None
        emp = converter_empresa(cnpj, lista, existentes.get(cnpj), numeros, tabela_bancos, a.beneficiario, rel)
        destino = os.path.join(a.saida, "atualizadas" if ja_existe else "novas")
        os.makedirs(destino, exist_ok=True)
        with open(os.path.join(destino, emp["id"] + ".json"), "w", encoding="utf-8") as f:
            json.dump(emp, f, ensure_ascii=False, indent=2)
    with open(os.path.join(a.saida, "relatorio-conversao.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rel[0].keys()) if rel else ["empresa"], delimiter=";")
        w.writeheader()
        w.writerows(rel)
    print(f"{len(rel)} empresas convertidas em {a.saida}")
    for r in rel:
        print(f"  {r['empresa'][:40]:40} {r['situacao']:34} +{r['regras_novas']} regras" + (f"  ATENÇÃO: {r['atencao']}" if r["atencao"] else ""))


if __name__ == "__main__":
    main()
