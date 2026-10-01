#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Junta o JSON extraido + o modelo HTML num unico arquivo (conciliador-tributos.html), com os dados embutidos (gzip+base64)."""
import argparse, base64, gzip, json, os, re

TRIBUTOS = {
    "001": "ICMS", "002": "IPI", "006": "CSLL", "007": "IRPJ", "008": "Diferencial de alíquota", "009": "Substituição tributária",
    "016": "IRRF", "018": "ISS retido", "025": "CRF (PIS/COFINS/CSLL retidos)", "026": "INSS retido", "027": "ICMS antecipado",
    "031": "ICMS antecipação total (ST)", "055": "FECOP-ICMS normal", "057": "FECP-DIFALI", "063": "IRRF pessoa física", "082": "082",
    "133": "PIS importação", "134": "COFINS importação", "145": "ICMS DIFAL (não contribuinte)",
}


def enxuga(d):
    emps = {}
    for nome, inf in d["empresas"].items():
        k = nome.split()[-1].upper()
        emps[k] = dict(pasta=nome, nome=inf["nome"], cnpj=inf["cnpj"])
    chave = {v["pasta"]: k for k, v in emps.items()}
    demos = []
    for x in d["demonstrativos"]:
        m = re.match(r"(\d{3})", x["pasta"])
        tri = m.group(1) if m else x["pasta"]
        idx = 5 if (x.get("colunas") and "Cliente" in x["colunas"]) else 3
        docs = []
        for dd in x["docs"]:
            v = dd["v"]
            if len(v) <= idx:
                continue
            sec = "D" if (dd["sec"] or "").startswith("DÉBITOS") else "C" if (dd["sec"] or "").startswith("CRÉDITOS") else ""
            docs.append([sec, dd["mov"] or "", dd["tipo"], dd["num"], dd["data"], v[0], v[1], v[2], v[idx], dd["txt"] or ""])
        demos.append(dict(
            e=chave[x["empresa"]], tri=tri, c=x["comp"], per=x.get("periodicidade"), uf=x.get("uf"),
            fn=x.get("fornecedor_nome"), fc=x.get("fornecedor_cnpj"), arq=x["arquivo"], titulo=x.get("titulo"),
            deb=x["debitos"], cred=x["creditos"], rec=x["a_recolher"], vp=x["valor_periodo"], sc=x["saldo_credor_seguinte"], sca=x["saldo_credor_anterior"],
            ig=x["imposto_docs"], debN=x["deb_notas"], credN=x["cred_notas"], debA=x["deb_apur"], credA=x["cred_apur"],
            res=x["resumo"], conf=x["confere"], tot=[[t["rotulo"], t["sec"], t["v"]] for t in x["totais"]], docs=docs,
        ))
    rets = []
    for r in d["retencoes"]:
        if r["visao"] != "impostos":
            continue
        for l in r["linhas"]:
            rets.append(dict(e=chave[l["empresa"]], ic=l["imp_cod"], im=l["imposto"], nota=l["nota"], data=l["data"], valor=l["valor"], ret=l["retencao"],
                             cr=l["cod_rec"], nat=l["nat"], fc=l["forn_cod"], fn=l["forn_nome"]))
    ret_info = [dict(e=chave[r["empresa"]], visao=r["visao"], periodo=r["periodo"], n=r["n"],
                     total=[t[1] for t in r["totais"] if t[0] == "Geral"][:1]) for r in d["retencoes"]]
    return dict(emps=emps, tributos=TRIBUTOS, demos=demos, rets=rets, retInfo=ret_info)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dados")
    ap.add_argument("--modelo", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "modelo.html"))
    ap.add_argument("--saida", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "conciliador-tributos.html"))
    a = ap.parse_args()
    d = json.load(open(a.dados, encoding="utf-8"))
    pacote = json.dumps(enxuga(d), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    b64 = base64.b64encode(gzip.compress(pacote, 9)).decode("ascii")
    html = open(a.modelo, encoding="utf-8").read().replace("/*__DADOS__*/", b64)
    open(a.saida, "w", encoding="utf-8").write(html)
    print(f"{len(pacote) / 1e6:.1f} MB de dados -> {len(b64) / 1e6:.1f} MB embutidos; {a.saida} ({os.path.getsize(a.saida) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
