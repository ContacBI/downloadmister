#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Extrator de regras do Dominio (tela "Configuracao para Contabilizar Extrato Bancario")
a partir de uma GRAVACAO DE TELA (video .mp4/.avi) ou de uma PASTA de capturas (PNG/JPG).

Fluxo: quadros -> OCR (RapidOCR, offline, sem acentos) -> uma linha por regra -> junta as janelas da
rolagem sem repetir -> CSV de conferencia + JSON no formato do HUB.

Como gravar: MAXIMIZE a janela do Dominio (botao do meio no canto superior direito) para as 6 colunas
aparecerem ao mesmo tempo, e role a lista DEVAGAR de cima para baixo (uns 10 a 15 linhas por vez).

Uso:
  python extrair_regras.py GRAVACAO.mp4 --empresa "JANA FAVORETO" --banco 11 [--conta-id UUID]
"""
import argparse, csv, difflib, json, os, random, re, string, sys, time, unicodedata
from collections import Counter

import cv2
import numpy as np

try:
    from rapidocr_onnxruntime import RapidOCR
except ImportError:  # pragma: no cover
    sys.exit("Falta instalar: pip install rapidocr-onnxruntime opencv-python-headless numpy")

HIST_EXT = "<<HistExtBan>>"
TIPOS = {"SOMA": "Soma", "SUBTRAI": "Subtrai", "AMBOS": "Ambos"}
_OCR = None


def ocr():
    global _OCR
    if _OCR is None:
        _OCR = RapidOCR()
    return _OCR


def sem_acento(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def norm(s):
    return re.sub(r"\s+", " ", sem_acento(s or "").upper()).strip()


def sim(a, b):
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


# --------------------------------------------------------------------------------------------
# quadros
# --------------------------------------------------------------------------------------------
def iterar_quadros(origem, passo=2, estavel=0.6, minimo_mudanca=0.8, log=print):
    """Devolve so os quadros PARADOS (rolagem terminada) e diferentes do ultimo guardado."""
    if os.path.isdir(origem):
        arqs = sorted(f for f in os.listdir(origem) if f.lower().endswith((".png", ".jpg", ".jpeg", ".bmp")))
        for f in arqs:
            img = cv2.imread(os.path.join(origem, f))
            if img is not None:
                yield f, img
        return
    cap = cv2.VideoCapture(origem)
    if not cap.isOpened():
        sys.exit(f"Nao consegui abrir: {origem}")
    i, anterior, ultimo, candidato = 0, None, None, None
    pequeno = lambda im: cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), (480, 270)).astype(np.float32)
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        if i % passo == 0:
            g = pequeno(fr)
            parado = anterior is not None and float(np.abs(g - anterior).mean()) < estavel
            if parado and (ultimo is None or float(np.abs(g - ultimo).mean()) > minimo_mudanca):
                yield f"quadro{i}", fr
                ultimo = g
            anterior = g
        i += 1
    cap.release()


# --------------------------------------------------------------------------------------------
# leitura de uma tela
# --------------------------------------------------------------------------------------------
def _bbox(b):
    xs = [p[0] for p in b]; ys = [p[1] for p in b]
    return min(xs), min(ys), max(xs), max(ys)


def ler_tela_inteira(img):
    res, _ = ocr()(img)
    caixas = []
    for b, t, c in (res or []):
        x0, y0, x1, y1 = _bbox(b)
        caixas.append(dict(x0=x0, y0=y0, x1=x1, y1=y1, cy=(y0 + y1) / 2, t=t, c=float(c)))
    return caixas


def achar_grade(caixas):
    """Usa as palavras Soma/Subtrai/Ambos (uma por regra) para achar as linhas e o cabecalho para achar as colunas."""
    tipos = []
    for c in caixas:
        w = norm(c["t"]).replace(" ", "")
        k = difflib.get_close_matches(w, list(TIPOS), n=1, cutoff=0.8)
        if k and len(w) <= 9:
            tipos.append(dict(c, tipo=TIPOS[k[0]]))
    if len(tipos) < 3:
        return None
    # so a coluna "Tipo": a maioria tem x0 parecido
    xm = Counter(int(t["x0"] // 12) for t in tipos).most_common(1)[0][0]
    tipos = sorted([t for t in tipos if int(t["x0"] // 12) == xm], key=lambda t: t["cy"])
    if len(tipos) < 3:
        return None
    dif = np.diff([t["cy"] for t in tipos])
    passo = float(np.median(dif[dif > 4])) if (dif > 4).any() else None
    if not passo:
        return None
    # cabecalho
    cab = {}
    for c in caixas:
        n = norm(c["t"])
        if abs(c["cy"] - (tipos[0]["cy"] - passo * 1.15)) > passo * 1.2:
            continue
        for chave, padrao in (("parte", "PARTE DO HIST"), ("tipo", "TIPO"), ("doc", "NUMERO DO"), ("codigo", "CODIGO"),
                              ("contra", "CONTRAPARTIDA"), ("hist", "HISTORICO PARA")):
            if n.startswith(padrao) or (chave == "tipo" and n == "TIPO"):
                cab[chave] = c
    return dict(tipos=tipos, passo=passo, cab=cab)


def _cinza(recorte):
    g = cv2.cvtColor(recorte, cv2.COLOR_BGR2GRAY)
    if g.mean() < 140:  # linha selecionada (fundo azul, texto claro)
        g = 255 - g
    return g


def _vazios(g, minimo=3):
    """Colunas de pixels sem tinta: devolve as faixas (inicio, fim) de espacos entre palavras (>= minimo px)."""
    tinta = (g < 150).any(axis=0)
    if not tinta.any():
        return []
    idx = np.where(tinta)[0]
    a, b = idx[0], idx[-1] + 1
    faixas, i = [], a
    while i < b:
        if not tinta[i]:
            j = i
            while j < b and not tinta[j]:
                j += 1
            if j - i >= minimo:
                faixas.append((i, j))
            i = j
        else:
            i += 1
    return faixas


def _alargar_espacos(g, minimo=3, novo=8):
    tinta = (g < 150).any(axis=0)
    if not tinta.any():
        return g
    idx = np.where(tinta)[0]
    a, b = idx[0], idx[-1] + 1
    g = g[:, a:b]
    partes, prev = [], 0
    for (i, j) in _vazios(g, minimo):
        partes.append(g[:, prev:i])
        partes.append(np.full((g.shape[0], novo), 255, np.uint8))
        prev = j
    partes.append(g[:, prev:])
    return np.hstack(partes)


def _ocr_cinza(g, escala=4, interp=cv2.INTER_CUBIC):
    g = cv2.resize(g, None, fx=escala, fy=escala, interpolation=interp)
    g = cv2.copyMakeBorder(g, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)
    res, _ = ocr()(cv2.cvtColor(g, cv2.COLOR_GRAY2BGR))
    if not res:
        return "", 0.0
    res = sorted(res, key=lambda r: _bbox(r[0])[0])
    return re.sub(r"\s+", " ", " ".join(t for _, t, _ in res)).strip(), float(np.mean([c for _, _, c in res]))


def _ocr_por_palavra(g, minimo=3):
    tinta = (g < 150).any(axis=0)
    if not tinta.any():
        return None
    idx = np.where(tinta)[0]
    a, b = idx[0], idx[-1] + 1
    cortes, prev = [], a
    for (i, j) in _vazios(g, minimo):
        cortes.append((prev, i)); prev = j
    cortes.append((prev, b))
    partes, confs = [], []
    for (i, j) in cortes:
        txt, c = _ocr_cinza(g[:, max(0, i - 1):j + 1])
        if not txt:
            return None
        partes.append(txt); confs.append(c)
    return " ".join(partes), float(np.mean(confs))


_CACHE = {}


def ler_celula(img, x0, x1, y0, y1, texto=True):
    """Le uma celula. texto=True faz 3 leituras (variacoes de ampliacao) e escolhe por votacao: o OCR as vezes
    'cola' as palavras (PAGAMENTOFORNECEDOR); a largura real dos espacos vem da propria imagem."""
    x0, x1, y0, y1 = int(max(0, x0)), int(min(img.shape[1], x1)), int(max(0, y0)), int(min(img.shape[0], y1))
    if x1 - x0 < 6 or y1 - y0 < 6:
        return "", 0.0
    g = _cinza(img[y0:y1, x0:x1])
    chave = (cv2.resize(g, (48, 8)).tobytes(), g.shape[1], texto)
    if chave in _CACHE:
        return _CACHE[chave]
    if not texto:
        out = _ocr_cinza(g)
    else:
        cand = [_ocr_cinza(g), _ocr_cinza(_alargar_espacos(g)), _ocr_cinza(g, 4, cv2.INTER_LANCZOS4)]
        cand = [c for c in cand if c[0]]
        if not cand:
            out = ("", 0.0)
        else:
            palavras = len(_vazios(g)) + 1
            sem = lambda s: s.replace(" ", "")
            voto = Counter(sem(c[0]) for c in cand)
            melhor_sem = voto.most_common(1)[0][0]
            grupo = [c for c in cand if sem(c[0]) == melhor_sem]
            # entre as leituras com as mesmas letras, a que tem o numero de palavras mais perto do da imagem
            grupo.sort(key=lambda c: (abs(c[0].count(" ") + 1 - palavras), -c[1]))
            out = (grupo[0][0], float(np.mean([c[1] for c in cand])))
            if len(voto) > 1 and voto.most_common(1)[0][1] == 1:
                out = (out[0], min(out[1], 0.6))  # as 3 leituras discordam: duvidoso
            # palavras coladas (faltam espacos que a imagem mostra): le palavra por palavra
            if palavras - (out[0].count(" ") + 1) >= 2:
                por_palavra = _ocr_por_palavra(g)
                if por_palavra and por_palavra[0].count(" ") + 1 >= palavras - 1:
                    out = (por_palavra[0], min(out[1], por_palavra[1]))
    if texto and out[0]:
        # o numero de palavras do texto lido nao bate com o de espacos da imagem: leitura duvidosa
        if abs((out[0].count(" ") + 1) - (len(_vazios(g)) + 1)) >= 1:
            out = (out[0], min(out[1], 0.6))
    _CACHE[chave] = out
    return out


class Colunas:
    """x (em pixels do quadro) onde cada coluna comeca. Calibrado uma vez por gravacao."""
    def __init__(self, parte_x0, tipo_x0, codigo_x0, contra_x0, hist_x0, fim_x):
        self.parte_x0, self.tipo_x0, self.codigo_x0, self.contra_x0, self.hist_x0, self.fim_x = \
            parte_x0, tipo_x0, codigo_x0, contra_x0, hist_x0, fim_x

    def __repr__(self):
        return f"Colunas(parte={self.parte_x0:.0f} tipo={self.tipo_x0:.0f} codigo={self.codigo_x0:.0f} contra={self.contra_x0:.0f} hist={self.hist_x0:.0f} fim={self.fim_x:.0f})"


def calibrar(img, grade, manual=None):
    """Acha os limites das colunas. Tipo vem das palavras Soma/Subtrai/Ambos; historico do inicio comum do texto
    da ultima coluna; codigo/contrapartida pela posicao dos numeros."""
    passo = grade["passo"]
    tipos = grade["tipos"]
    tipo_x0 = float(np.median([t["x0"] for t in tipos]))
    tipo_x1 = float(np.median([t["x1"] for t in tipos]))
    cab = grade["cab"]
    parte_x0 = (cab["parte"]["x0"] if "parte" in cab else 0) - 0
    # grade comeca no primeiro pixel de texto das celulas da coluna Parte
    lin = img[int(tipos[0]["cy"] - passo / 2): int(tipos[0]["cy"] + passo / 2), :int(tipo_x0 - 4)]
    g = cv2.cvtColor(lin, cv2.COLOR_BGR2GRAY)
    if g.mean() < 140:
        g = 255 - g
    tinta = np.where((g < 140).any(axis=0))[0]
    parte_x0 = float(tinta[0]) if len(tinta) else 0.0
    # primeira passada: linha inteira, depois do Tipo, para achar onde comecam os textos
    lefts_ultimo, digitos_x = [], []
    for t in tipos[:40]:
        y0, y1 = t["cy"] - passo / 2 + 1, t["cy"] + passo / 2 - 1
        rec = img[int(y0):int(y1), int(tipo_x1) + 4:]
        gg = cv2.copyMakeBorder(cv2.resize(_cinza(rec), None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC), 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)
        res, _ = ocr()(cv2.cvtColor(gg, cv2.COLOR_GRAY2BGR))
        if not res:
            continue
        res = sorted(res, key=lambda r: _bbox(r[0])[0])
        bx = [((_bbox(b)[0] - 12) / 4 + tipo_x1 + 4, txt) for b, txt, _ in res]
        if len(bx) >= 2:
            lefts_ultimo.append(int(round(bx[-1][0] / 3)))
        for x, txt in bx:
            if re.match(r"^\d{1,5}", txt):
                digitos_x.append(x)
                break
    if manual:
        return Colunas(parte_x0, tipo_x0 - 3, manual["codigo_x0"], manual["contra_x0"], manual["hist_x0"], manual["fim_x"]), None
    if not lefts_ultimo:
        return None, "nao consegui achar a coluna de historico contabil (a janela esta maximizada e mostra as 6 colunas?)"
    hist_x0 = Counter(lefts_ultimo).most_common(1)[0][0] * 3 - 2
    # refina: media das posicoes reais dessa coluna
    cod_x0 = (min(digitos_x) - 6) if digitos_x else tipo_x1 + 10
    contra_x0 = cod_x0 + 40
    fim_x = img.shape[1] - 6
    cab_hist = cab.get("hist")
    if cab_hist:
        fim_x = min(fim_x, cab_hist["x1"] + (cab_hist["x1"] - cab_hist["x0"]) * 2)
    return Colunas(parte_x0, tipo_x0 - 3, cod_x0, contra_x0, hist_x0, img.shape[1] - 6), None


def ler_linhas(img, cols, grade):
    passo = grade["passo"]
    linhas = []
    for t in grade["tipos"]:
        y0, y1 = t["cy"] - passo / 2 + 1, t["cy"] + passo / 2 - 1
        parte, c1 = ler_celula(img, cols.parte_x0 - 2, cols.tipo_x0, y0, y1)
        corpo, c2 = ler_celula(img, cols.codigo_x0, cols.hist_x0 - 1, y0, y1, texto=False)
        hist, c3 = ler_celula(img, cols.hist_x0, cols.fim_x, y0, y1)
        cod, contra = separar_codigo(corpo)
        linhas.append(dict(parte=parte, tipo=t["tipo"], cod=cod, contra=contra, hist=hist, conf=min(c for c in (c1, c2, c3) if c > 0) if any((c1, c2, c3)) else 0.0))
    return linhas


def separar_codigo(corpo):
    """'2913DESPESAS BANCARIAS' -> ('2913', 'DESPESAS BANCARIAS'); '371055.497.714 MARIA' -> ('3710', '55.497.714 MARIA')."""
    m = re.match(r"^\s*(\d+)(.*)$", corpo or "")
    if not m:
        return "", (corpo or "").strip()
    dig, resto = m.group(1), m.group(2)
    m2 = re.match(r"^(\.\d{3}\.\d{3}.*)$", resto)  # resto de um CNPJ/CPF "NN.NNN.NNN" colado ao codigo
    if m2 and len(dig) > 2:
        return dig[:-2], dig[-2:] + resto
    if len(dig) > 5:
        return dig[:4], dig[4:] + resto
    return dig, resto.strip()


# --------------------------------------------------------------------------------------------
# junta as janelas da rolagem
# --------------------------------------------------------------------------------------------
def igual(a, b):
    return 0.5 * sim(a["parte"], b["parte"]) + 0.3 * sim(a["hist"], b["hist"]) + 0.2 * (a["cod"] == b["cod"]) if a["tipo"] == b["tipo"] else 0.0


def juntar(janelas, limite=0.72, minimo=3):
    geral, avisos = [], []
    orfas = []
    for n, w in enumerate(janelas):
        if not geral:
            geral = [[r] for r in w]
            continue
        melhor = None
        for off in range(-(len(w) - 1), len(geral)):
            pares = [(i, off + i) for i in range(len(w)) if 0 <= off + i < len(geral)]
            if len(pares) < minimo:
                continue
            pont = [igual(w[i], geral[j][0]) for i, j in pares]
            boas = sum(p >= limite for p in pont)
            if boas >= min(minimo, len(pares)) and boas / len(pares) >= 0.6:
                if melhor is None or boas > melhor[0]:
                    melhor = (boas, off)
        if melhor is None:
            orfas.append(n)
            continue
        off = melhor[1]
        if off < 0:
            geral = [[r] for r in w[:-off]] + geral
            off = 0
        for i, r in enumerate(w):
            j = off + i + (0 if melhor[1] >= 0 else -melhor[1] * 0)
            j = melhor[1] + i + (-melhor[1] if melhor[1] < 0 else 0)
            if j < len(geral):
                geral[j].append(r)
            else:
                geral.append([r])
    if orfas:
        avisos.append(f"{len(orfas)} tela(s) sem sobreposicao com as demais (janelas {orfas}): pode ter faltado linha. "
                      f"Role mais devagar, deixando umas 3 linhas repetidas entre uma tela e a proxima.")
    return geral, avisos


def votar(obs):
    """Escolhe, por campo, o texto que mais apareceu (desempata pela confianca)."""
    out, duvida = {}, False
    for campo in ("parte", "tipo", "cod", "contra", "hist"):
        vals = Counter()
        for o in obs:
            vals[o[campo]] += 1 + o["conf"]
        v, _ = vals.most_common(1)[0]
        out[campo] = v
        if len(set(o[campo] for o in obs)) > 1 and campo in ("parte", "cod", "hist"):
            duvida = True
    out["obs"] = len(obs)
    out["conf"] = float(np.mean([o["conf"] for o in obs]))
    out["conferir"] = duvida or len(obs) < 2 or out["conf"] < 0.85 or not out["cod"]
    return out


# --------------------------------------------------------------------------------------------
# saidas
# --------------------------------------------------------------------------------------------
def novo_id(rnd, carimbo):
    return "id-%s-%s" % (carimbo, "".join(rnd.choice(string.ascii_lowercase + string.digits) for _ in range(8)))


def gerar_json(regras, conta_id, expandir):
    rnd = random.Random(time.time())
    carimbo = format(int(time.time() * 1000), "x")[-8:]
    out = []
    for r in regras:
        if not r["parte"]:
            continue
        hist = "" if norm(r["hist"]) in ("", norm(HIST_EXT), "<<HISTEXTBAN>>") or "HISTEXTBAN" in norm(r["hist"]) else r["hist"]
        if r["tipo"] == "Soma":
            nats = ["RECEBIMENTO"]
        elif r["tipo"] == "Subtrai":
            nats = ["PAGAMENTO"]
        else:
            nats = ["PAGAMENTO", "RECEBIMENTO"] if expandir else ["AMBOS"]
        for nat in nats:
            out.append(dict(id=novo_id(rnd, carimbo), ativo=True, historico=r["parte"], historicoPadrao=hist, modo="CONTEM",
                            natureza=nat, conta=r["cod"], contaId=conta_id, valor=None))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("origem", help="video (.mp4/.avi) ou pasta com capturas PNG")
    ap.add_argument("--empresa", default="empresa", help="nome (usado nos arquivos de saida)")
    ap.add_argument("--banco", default="", help="codigo contabil do banco no Dominio (so para o relatorio)")
    ap.add_argument("--conta-id", default=None, help="id da conta bancaria no HUB (vazio = vale para todas as contas)")
    ap.add_argument("--saida", default=None, help="pasta de saida (padrao: ./saida_<empresa>)")
    ap.add_argument("--passo", type=int, default=2, help="1 a cada N quadros do video (padrao 2)")
    ap.add_argument("--colunas", default=None, help='ajuste manual: "codigo_x0,contra_x0,hist_x0,fim_x" em pixels do quadro')
    a = ap.parse_args()

    slug = re.sub(r"[^A-Za-z0-9]+", "_", sem_acento(a.empresa)).strip("_") or "empresa"
    saida = a.saida or f"saida_{slug}"
    os.makedirs(saida, exist_ok=True)
    manual = None
    if a.colunas:
        v = [float(x) for x in a.colunas.split(",")]
        manual = dict(codigo_x0=v[0], contra_x0=v[1], hist_x0=v[2], fim_x=v[3])

    t0 = time.time()
    cols, grade0, primeiro = None, None, None
    janelas, n_quadros, n_ignorados = [], 0, 0
    for nome, img in iterar_quadros(a.origem, a.passo):
        n_quadros += 1
        caixas = ler_tela_inteira(img)
        grade = achar_grade(caixas)
        if not grade:
            n_ignorados += 1
            continue
        if cols is None:
            cols, erro = calibrar(img, grade, manual)
            if not cols:
                n_ignorados += 1
                print("Aviso:", erro)
                continue
            primeiro = img.copy()
            print("Colunas detectadas:", cols)
        linhas = ler_linhas(img, cols, grade)
        if linhas:
            janelas.append(linhas)
        print(f"  quadro {n_quadros}: {len(linhas)} linhas ({time.time() - t0:.0f}s)", end="\r")
    print()
    if not janelas:
        sys.exit("Nao encontrei a grade de regras em nenhum quadro. Confira se a janela do Dominio esta maximizada e visivel na gravacao.")

    geral, avisos = juntar(janelas)
    regras = [votar(obs) for obs in geral]

    # desenho de conferencia das colunas
    if primeiro is not None and cols:
        dbg = primeiro.copy()
        for x, cor in ((cols.parte_x0, (255, 0, 0)), (cols.tipo_x0, (0, 140, 255)), (cols.codigo_x0, (0, 200, 0)),
                       (cols.hist_x0, (0, 0, 255)), (cols.fim_x, (200, 0, 200))):
            cv2.line(dbg, (int(x), 0), (int(x), dbg.shape[0]), cor, 1)
        cv2.imwrite(os.path.join(saida, "colunas_detectadas.png"), dbg)

    # CSV de conferencia
    arq_csv = os.path.join(saida, f"conferencia_{slug}.csv")
    with open(arq_csv, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["#", "Parte do historico no extrato", "Tipo", "Codigo contrapartida", "Contrapartida (conferencia)", "Historico para o lancamento contabil", "Vezes lida", "Conferir?"])
        for i, r in enumerate(regras, 1):
            w.writerow([i, r["parte"], r["tipo"], r["cod"], r["contra"], r["hist"], r["obs"], "SIM" if r["conferir"] else ""])
    arq1 = os.path.join(saida, f"regras-{slug}-banco{a.banco or 'X'}.json")
    arq2 = os.path.join(saida, f"regras-{slug}-banco{a.banco or 'X'}-AMBOS-expandido.json")
    for arq, exp in ((arq1, False), (arq2, True)):
        with open(arq, "w", encoding="utf-8") as f:
            json.dump(gerar_json(regras, a.conta_id, exp), f, ensure_ascii=False, indent=2)

    n_conf = sum(r["conferir"] for r in regras)
    print(f"\n{len(regras)} regras lidas de {len(janelas)} telas ({n_quadros} quadros, {n_ignorados} sem a grade) em {time.time() - t0:.0f}s")
    print(f"  {n_conf} marcadas 'Conferir?' no CSV (leitura duvidosa)")
    for av in avisos:
        print("  AVISO:", av)
    print("Arquivos:\n ", arq_csv, "\n ", arq1, "\n ", arq2)
    print("Confira SEMPRE o CSV contra a tela do Dominio (principalmente os codigos) antes de importar.")


if __name__ == "__main__":
    main()
