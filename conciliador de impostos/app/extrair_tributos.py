#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Conciliador de tributos -- extrai os "Demonstrativos" e as "Retencoes a Recolher" (PDFs do Dominio) para um JSON.

Uso:  python extrair_tributos.py "..\\" --saida dados_tributos.json
      (a pasta tem uma subpasta por empresa/filial, cada uma com as pastas de imposto)
"""
import argparse, collections, glob, json, os, re, sys, time
import pymupdf

NUM = r"-?\d{1,3}(?:\.\d{3})*,\d{2}"
RE_NUM = re.compile(r"\(?(" + NUM + r")\)?%?")
RE_DOC = re.compile(r"^(?:[01]\s+)?([A-Za-z][A-Za-z\-]*): (\S+) (\d{2}/\d{2}/\d{4})\s*(.*)$")
RE_COMP = re.compile(r"Compet[eê]ncia:\s*(\d{2})/(\d{4})")
RE_CNPJ = re.compile(r"CNPJ:\s*([\d./-]+)")


def br(s):
    s = s.strip().replace("(", "-").replace(")", "")
    return float(s.replace("%", "").replace(".", "").replace(",", "."))


def nums(txt):
    out = []
    for m in RE_NUM.finditer(txt):
        v = br(m.group(1))
        if m.group(0).startswith("("):
            v = -abs(v)
        out.append(v)
    return out


def linhas(path, tol=2.5):
    d = pymupdf.open(path)
    out = []
    for pn, p in enumerate(d, 1):
        ws = sorted(p.get_text("words"), key=lambda w: (w[1] + w[3]) / 2)
        grupos = []
        for w in ws:
            cy = (w[1] + w[3]) / 2
            if grupos and abs(grupos[-1][0] - cy) <= tol:
                grupos[-1][1].append(w)
            else:
                grupos.append([cy, [w]])
        for cy, g in grupos:
            g.sort(key=lambda w: w[0])
            out.append((pn, " ".join(w[4] for w in g)))
    return out


def limpa(t):
    t = t.strip()
    t = re.sub(r"^[01]\s*(?=[A-Za-zÀ-ú])", "", t)       # "1Débitos pelas saídas", "0Fornecedor:", "1 Total Geral:"
    return t.strip()


def meta_arquivo(nome):
    """Demonst. ICMS 082026 (M) ... -> periodo, periodicidade, uf, fornecedor"""
    m = re.search(r"\b(\d{2})(\d{4})\b", nome)
    comp = f"{m.group(2)}-{m.group(1)}" if m else None
    per = re.search(r"\((M|PN|\d\s*T)\)", nome)
    uf = re.search(r"DIFAL(?:-NC)?\s+\d{6}\s+([A-Z]{2})\b", nome)
    forn = re.search(r"2631 - ([\d.\-]+)\s*\((.*)\)\.pdf$", nome)
    return dict(comp=comp, periodicidade=per.group(1) if per else None, uf=uf.group(1) if uf else None,
                fornecedor_cnpj=forn.group(1) if forn else None, fornecedor_nome=forn.group(2) if forn else None)


def parse_demonstrativo(path):
    L = linhas(path)
    r = dict(empresa_nome=None, cnpj=None, comp=None, titulo=None, colunas=None, docs=[], totais=[], resumo={}, outros=[], paginas=L[-1][0] if L else 0)
    secao, mov, estab = None, None, None
    sec_resumo = None
    for pn, t0 in L:
        t = limpa(t0)
        if not t or t.startswith("Sistema licenciado"):
            continue
        m = re.match(r"^(.*?)\s+P[aá]gina:\s*\d+/\d+$", t)
        if m:
            r["empresa_nome"] = r["empresa_nome"] or m.group(1).strip(); continue
        m = RE_CNPJ.search(t)
        if m and "Emiss" in t:
            r["cnpj"] = r["cnpj"] or m.group(1); continue
        m = RE_COMP.search(t)
        if m:
            r["comp"] = f"{m.group(2)}-{m.group(1)}"; continue
        if t.startswith("DEMONSTRATIVO"):
            r["titulo"] = r["titulo"] or t; continue
        if t.startswith("Documento Data") or t.startswith("Movimento Data"):
            r["colunas"] = r["colunas"] or t; continue
        if t in ("DÉBITOS", "CRÉDITOS", "APURAÇÃO"):
            sec_resumo = t; continue
        if t.startswith("Descrição Valor"):
            continue
        if re.match(r"^D[ÉE]BITOS PEL", t) or re.match(r"^CR[ÉE]DITOS PEL", t):
            secao = t; mov = None; sec_resumo = None; continue
        if t.startswith("DÉBITOS PELOS") or t.startswith("DEBITOS PELOS"):
            secao = t; sec_resumo = None; continue
        if t == "SEM MOVIMENTO":
            r["outros"].append(dict(secao=secao, texto=t)); continue
        m = re.match(r"^Movimento:\s*(.+)$", t)
        if m:
            mov = m.group(1).strip(); continue
        m = re.match(r"^Estabelecimento:\s*(.+)$", t)
        if m:
            estab = m.group(1).strip(); continue
        if t in ("Saídas", "Entradas", "Serviços prestados") or re.match(r"^(Saídas|Entradas)\b[^\d]*$", t):
            mov = t; continue
        m = RE_DOC.match(t)
        if m:
            r["docs"].append(dict(sec=secao, mov=mov, tipo=m.group(1), num=m.group(2), data=m.group(3), v=nums(m.group(4)), pg=pn, txt=(re.sub(r"\(?" + NUM + r"\)?%?", "", m.group(4)).strip()[:70] or None)))
            continue
        m = re.match(r"^(Total[^:]*):\s*(.*)$", t)
        if m:
            r["totais"].append(dict(sec=secao, mov=mov, rotulo=m.group(1).strip(), v=nums(m.group(2)))); continue
        m = re.match(r"^(.*?)\s+(" + NUM + r")$", t)
        if m and sec_resumo:
            r["resumo"].setdefault(sec_resumo, []).append([re.sub(r"^[01]\s+", "", m.group(1)).strip(), br(m.group(2))]); continue
        m = re.match(r"^(Total de d[ée]bitos|Total de cr[ée]ditos)\s+(" + NUM + r")$", t)
        if m and not sec_resumo:      # DIFAL (nao contribuinte) imprime o resumo sem os titulos DEBITOS/APURACAO
            r["resumo"].setdefault("DÉBITOS" if "d" in m.group(1)[9:10] else "CRÉDITOS", []).append([m.group(1), br(m.group(2))]); continue
        m = re.match(r"^(D[ée]bitos pelas sa[ií]das .*?)\s+(" + NUM + r")$", t)
        if m and not sec_resumo:
            r["resumo"].setdefault("DÉBITOS", []).append([m.group(1), br(m.group(2))]); continue
        # linhas de nota com varios valores sem prefixo de documento (ex.: CSLL "Total da nota", deducoes)
        if nums(t):
            r["outros"].append(dict(secao=secao, mov=mov, texto=t[:140], v=nums(t)))
    return r


def derivar(x):
    """Numeros-chave de um demonstrativo: imposto das notas, totais, debitos, creditos, a recolher, saldo credor."""
    idx = 5 if (x.get("colunas") and "Cliente" in x["colunas"]) else 3
    docs = [d for d in x["docs"] if len(d["v"]) > idx]
    if re.search(r"CSLL|IRPJ", x.get("titulo") or ""):
        docs = []   # layout proprio (receita x percentual de base): nao ha "valor do imposto" por nota pra conferir
    x["imposto_docs"] = round(sum(d["v"][idx] for d in docs), 2)
    tg = [tt for tt in x["totais"] if tt["rotulo"] == "Total Geral"]
    x["total_geral"] = tg[-1]["v"] if tg else None
    # conferencia interna por secao: soma do imposto das notas x "Total Geral" daquela secao (o total vem sem a coluna de aliquota)
    conf = []
    for sec in sorted({d["sec"] for d in docs}, key=lambda s: str(s)):
        soma = round(sum(d["v"][idx] for d in docs if d["sec"] == sec), 2)
        alvo = [tt["v"] for tt in tg if tt["sec"] == sec]
        alvo = [v for v in alvo if len(v) >= idx]
        if alvo:
            a = round(sum(v[idx - 1] for v in alvo), 2)   # ha um "Total Geral" por secao (ou um por movimento, no DIFAL)
        else:   # secao com um movimento so: nao existe "Total Geral", vale a soma dos "Total <movimento>"
            parc = [tt["v"] for tt in x["totais"] if tt["sec"] == sec and tt["rotulo"] != "Total Geral" and len(tt["v"]) >= idx]
            a = round(sum(p[idx - 1] for p in parc), 2) if parc else None
        conf.append(dict(sec=sec, notas=sum(1 for d in docs if d["sec"] == sec), soma=soma, total=a, ok=(a is not None and abs(soma - a) < 0.02)))
    x["confere"] = conf
    ap = x["resumo"].get("APURAÇÃO", [])
    rec = [v for l, v in ap if re.search(r"saldo devedor", l, re.I)] or [v for l, v in ap if re.search(r"a recolher$", l, re.I)]
    x["a_recolher"] = rec[0] if rec else None
    cs = [v for l, v in ap if re.search(r"saldo credor .*(m[eê]s|per[ií]odo) seguinte", l, re.I)]
    x["saldo_credor_seguinte"] = cs[0] if cs else None
    ant = [v for l, v in ap if re.search(r"saldo credor do per[ií]odo anterior", l, re.I)]
    x["saldo_credor_anterior"] = ant[0] if ant else None
    for chave, sec in (("debitos", "DÉBITOS"), ("creditos", "CRÉDITOS")):
        v = [v for l, v in x["resumo"].get(sec, []) if re.match(r"Total de (d[ée]bitos|cr[ée]ditos)", l, re.I)]
        x[chave] = v[0] if v else None
    # valor do periodo: o "a recolher" da apuracao; no DIFAL (nao contribuinte) nao ha apuracao -> debitos - creditos
    if x["a_recolher"] is not None:
        x["valor_periodo"] = x["a_recolher"]
    elif x["debitos"] is not None:
        x["valor_periodo"] = round(x["debitos"] - (x["creditos"] or 0), 2)
    else:
        x["valor_periodo"] = None
    # imposto somado das notas (por lado) x o que a apuracao levou a debito/credito
    x["deb_notas"] = round(sum(d["v"][idx] for d in docs if (d["sec"] or "").startswith("DÉBITOS PEL")), 2) if docs else None
    x["cred_notas"] = round(sum(d["v"][idx] for d in docs if (d["sec"] or "").startswith("CRÉDITOS PEL")), 2) if docs else None
    da = [v for l, v in x["resumo"].get("DÉBITOS", []) if re.match(r"D[ée]bitos pel", l)]
    ca = [v for l, v in x["resumo"].get("CRÉDITOS", []) if re.match(r"Cr[ée]ditos pel", l)]
    x["deb_apur"] = da[0] if da else None
    x["cred_apur"] = ca[0] if ca else None
    return x


def parse_retencoes(path):
    L = linhas(path)
    r = dict(cnpj=None, periodo=None, visao=None, linhas=[], totais=[])
    forn, imp = None, None
    for pn, t0 in L:
        t = limpa(t0)
        if not t:
            continue
        m = RE_CNPJ.search(t)
        if m and "Emiss" in t:
            r["cnpj"] = m.group(1); continue
        m = re.search(r"Per[ií]odo:\s*(\d{2}/\d{2}/\d{4}) a (\d{2}/\d{2}/\d{4})", t)
        if m:
            r["periodo"] = [m.group(1), m.group(2)]; continue
        if t.startswith("Código Imposto"):
            r["visao"] = "impostos"; continue
        if t.startswith("Código Fornecedor"):
            r["visao"] = "fornecedor"; continue
        m = re.match(r"^Fornecedor:\s*(\d+)\s+(.*)$", t)
        if m:
            forn = (m.group(1), m.group(2)); continue
        m = re.match(r"^Imposto:\s*(\d+)\s+(.*)$", t)
        if m:
            imp = (m.group(1), m.group(2)); continue
        m = re.match(r"^Total (Fornecedor|Imposto|Geral):\s*(" + NUM + r")", t)
        if m:
            r["totais"].append([m.group(1), br(m.group(2)), forn[0] if (forn and m.group(1) == "Fornecedor") else None, imp[0] if (imp and m.group(1) == "Imposto") else None]); continue
        t2 = re.sub(r"^[01]\s+", "", t)
        if r["visao"] == "impostos":
            m = re.match(r"^(\d+)\s+(.+?)\s+(\S+)\s+(\d{2}/\d{2}/\d{4})\s+(" + NUM + r")\s+(" + NUM + r")(?:\s+(\d+))?(?:\s+(\d+))?$", t2)
            if m and forn:
                r["linhas"].append(dict(imp_cod=m.group(1), imposto=m.group(2), nota=m.group(3), data=m.group(4), valor=br(m.group(5)), retencao=br(m.group(6)),
                                        cod_rec=m.group(7) or "", nat=m.group(8) or "", forn_cod=forn[0], forn_nome=forn[1], pg=pn))
        elif r["visao"] == "fornecedor":
            m = re.match(r"^(\d+)\s+(.+?)\s+(\S+)\s+(\d{2}/\d{2}/\d{4})\s+(" + NUM + r")\s+(" + NUM + r")(?:\s+(\d+))?(?:\s+(\d+))?$", t2)
            if m and imp:
                r["linhas"].append(dict(imp_cod=imp[0], imposto=imp[1], nota=m.group(3), data=m.group(4), valor=br(m.group(5)), retencao=br(m.group(6)),
                                        cod_rec=m.group(7) or "", nat=m.group(8) or "", forn_cod=m.group(1), forn_nome=m.group(2), pg=pn))
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("raiz")
    ap.add_argument("--saida", default="dados_tributos.json")
    a = ap.parse_args()
    t0 = time.time()
    empresas, demos, rets = {}, [], []
    for emp_dir in sorted(d for d in glob.glob(os.path.join(a.raiz, "*")) if os.path.isdir(d)):
        emp = os.path.basename(emp_dir)
        if emp.startswith(".") or emp == "app":
            continue
        for f in sorted(glob.glob(os.path.join(emp_dir, "**", "*.pdf"), recursive=True)):
            nome = os.path.basename(f)
            if not (nome.startswith("Demonst.") or nome.startswith("Reten")):
                print("  ignorado (nao e Demonst./Retencoes):", os.path.relpath(f, a.raiz)); continue
            pasta = os.path.basename(os.path.dirname(f)) if os.path.dirname(f) != emp_dir else ""
            try:
                if nome.startswith("Reten"):
                    p = parse_retencoes(f)
                    for l in p["linhas"]:
                        l.update(empresa=emp, arquivo=nome, visao=p["visao"])
                    rets.append(dict(empresa=emp, arquivo=nome, visao=p["visao"], cnpj=p["cnpj"], periodo=p["periodo"], totais=p["totais"], n=len(p["linhas"]), linhas=p["linhas"]))
                else:
                    p = parse_demonstrativo(f)
                    p.update(empresa=emp, pasta=pasta, arquivo=nome, **meta_arquivo(nome))
                    p["comp"] = p.get("comp") or meta_arquivo(nome)["comp"]
                    derivar(p)
                    demos.append(p)
                    empresas.setdefault(emp, dict(cnpj=p["cnpj"], nome=p["empresa_nome"]))
            except Exception as e:
                print("ERRO", f, e, file=sys.stderr)
        print(f"{emp}: ok ({time.time() - t0:.0f}s)")
    json.dump(dict(empresas=empresas, demonstrativos=demos, retencoes=rets), open(a.saida, "w", encoding="utf-8"), ensure_ascii=False)
    print(len(demos), "demonstrativos,", sum(r["n"] for r in rets), "linhas de retencao ->", a.saida, f"({os.path.getsize(a.saida) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
