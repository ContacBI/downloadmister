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
    if texto and out[0]:
        limpo = re.sub(r"^[\s:;|.,'`!]+", "", out[0])   # a borda da celula as vezes vira ':' ou '|' no inicio do texto
        out = (limpo, out[1])
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


def _alinhar(A, B, limite=0.72, minimo=3):
    """Melhor posicao de B dentro de A (por sobreposicao de linhas parecidas). Devolve (acertos, offset) ou None."""
    melhor = None
    for off in range(-(len(B) - 1), len(A)):
        pares = [(i, off + i) for i in range(len(B)) if 0 <= off + i < len(A)]
        if len(pares) < minimo:
            continue
        boas = sum(igual(B[i][0], A[j][0]) >= limite for i, j in pares)
        if boas >= min(minimo, len(pares)) and boas / len(pares) >= 0.6 and (melhor is None or boas > melhor[0]):
            melhor = (boas, off)
    return melhor


def _fundir(A, B, off):
    ini, fim = min(0, off), max(len(A), off + len(B))
    out = []
    for pos in range(ini, fim):
        obs = []
        if 0 <= pos < len(A):
            obs += A[pos]
        j = pos - off
        if 0 <= j < len(B):
            obs += B[j]
        out.append(obs)
    return out


def juntar(janelas, limite=0.72, minimo=3):
    """Junta as telas da rolagem numa lista unica, sem repetir as linhas que aparecem em duas telas."""
    clusters = [[[r] for r in w] for w in janelas if w]
    mudou = True
    while mudou and len(clusters) > 1:
        mudou = False
        for i in range(len(clusters)):
            for j in range(len(clusters)):
                if i == j:
                    continue
                m = _alinhar(clusters[i], clusters[j], limite, minimo)
                if m:
                    clusters[i] = _fundir(clusters[i], clusters[j], m[1])
                    del clusters[j]
                    mudou = True
                    break
            if mudou:
                break
    avisos = []
    if len(clusters) > 1:
        avisos.append(f"{len(clusters)} trechos da lista nao se encontram (sem linhas repetidas entre eles): pode ter faltado linha entre um trecho e o seguinte. "
                      f"Role mais devagar, deixando umas 3 linhas repetidas entre uma tela e a proxima. Os trechos foram colocados na ordem em que apareceram.")
    geral = [obs for c in clusters for obs in c]
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
    out["conferir"] = duvida or out["conf"] < 0.85 or not out["cod"]
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


# --------------------------------------------------------------------------------------------
# janela NAO maximizada: a grade mostra so uma parte das colunas de cada vez (esquerda / meio / direita)
# --------------------------------------------------------------------------------------------
def _corrida(v, limite=160, minimo=40):
    """Maior sequencia de pixels escuros (a 'alca' da barra de rolagem). Devolve (inicio, fim) ou None."""
    m = v < limite
    melhor, i = None, 0
    while i < len(m):
        if m[i]:
            j = i
            while j < len(m) and m[j]:
                j += 1
            if j - i >= minimo and (melhor is None or j - i > melhor[1] - melhor[0]):
                melhor = (i, j)
            i = j
        else:
            i += 1
    return melhor


def barras(img, ref):
    """Posicao das 'alcas' das barras de rolagem (so pixels, sem OCR). ref = info_quadro de um quadro de referencia."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    y_h, cab_cy, inc, rep = ref["y_h"], ref["cab_cy"], ref["inc"], ref["rep"]
    hb = None
    for y in range(y_h - 6, y_h + 7):
        r = _corrida(g[y, 560:1300])
        if r and (hb is None or r[1] - r[0] > hb[1] - hb[0]):
            hb = (r[0] + 560, r[1] + 560)
    vb = None
    if rep is not None:
        y_a, y_b = int(cab_cy + 12), int(y_h - 12)
        for x in range(int(rep["x0"] - 76), int(rep["x0"] - 60)):
            r = _corrida(g[y_a:y_b, x], limite=160, minimo=25)   # a alca aparece como uma linha escura no meio da barra
            if r and r[1] - r[0] < (y_b - y_a) * 0.95 and (vb is None or r[1] - r[0] > vb[1] - vb[0]):
                vb = (r[0] + y_a, r[1] + y_a)
    if hb is not None and (hb[1] - hb[0] > 420 or hb[1] - hb[0] < 60):
        hb = None   # nao e uma alca de barra (quadro sem a janela do Dominio)
    return dict(hb=hb, vb=vb)


def info_quadro(img, ref=None):
    """Le o quadro inteiro uma vez (OCR): textos, posicoes das linhas e das barras de rolagem."""
    caixas = ler_tela_inteira(img)
    inc = next((c for c in caixas if norm(c["t"]).startswith("INCLUIR")), None)
    rep = next((c for c in caixas if norm(c["t"]).startswith("REPLICAR")), None)
    palavras = ("PARTE DO HIST", "TIPO", "NUMERO DO", "CODIGO", "CONTRAPARTIDA", "PARTIDA", "HISTORICO PARA", "LANCAMENTO CONTABIL")
    cab = [c for c in caixas if (inc is None or c["cy"] < inc["cy"] - 80) and any(norm(c["t"]).startswith(w) for w in palavras)]
    if ref is None and (not cab or inc is None):
        return None
    if ref is not None:
        inc, rep, cab_cy, y_h = ref["inc"], ref["rep"], ref["cab_cy"], ref["y_h"]
    else:
        cab_cy = Counter(int(c["cy"] // 6) for c in cab).most_common(1)[0][0] * 6 + 3
        cab = [c for c in cab if abs(c["cy"] - cab_cy) < 9]
        cab_cy = float(np.median([c["cy"] for c in cab]))
        y_h = int(inc["cy"] - 34)
    tipos = []
    for c in caixas:
        w = norm(c["t"]).replace(" ", "")
        k = difflib.get_close_matches(w, list(TIPOS), n=1, cutoff=0.8)
        if k and len(w) <= 9 and cab_cy + 8 < c["cy"] < inc["cy"] - 40:
            tipos.append(dict(c, tipo=TIPOS[k[0]]))
    if tipos:
        xm = Counter(int(t["x0"] // 12) for t in tipos).most_common(1)[0][0]
        tipos = sorted([t for t in tipos if int(t["x0"] // 12) == xm], key=lambda t: t["cy"])
    out = dict(caixas=caixas, inc=inc, rep=rep, cab_cy=cab_cy, tipos=tipos, y_h=y_h)
    out.update(barras(img, out))
    return out


def _caixas_da_linha(img, cy, passo, x0, x1):
    y0, y1 = cy - passo / 2 + 1, cy + passo / 2 - 1
    x0, x1 = int(max(0, x0)), int(min(img.shape[1], x1))
    rec = img[int(y0):int(y1), x0:x1]
    gg = cv2.copyMakeBorder(cv2.resize(_cinza(rec), None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC), 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)
    res, _ = ocr()(cv2.cvtColor(gg, cv2.COLOR_GRAY2BGR))
    out = []
    for b, txt, _ in sorted(res or [], key=lambda r: _bbox(r[0])[0]):
        out.append(((_bbox(b)[0] - 12) / 4 + x0, txt))
    return out


def _moda_ultimo(img, cys, passo, x0, x1):
    lefts = []
    for cy in cys[:40]:
        bx = _caixas_da_linha(img, cy, passo, x0, x1)
        if len(bx) >= 2:
            lefts.append(int(round(bx[-1][0] / 3)))
    return Counter(lefts).most_common(1)[0][0] * 3 - 2 if lefts else None


def processar_multivisao(grupos, x0min, x1max, log=print):
    """grupos: lista de blocos; cada bloco = lista de (nome, img, info). Junta esquerda/meio/direita de cada bloco de linhas."""
    quadros = [q for g in grupos for q in g]
    grid_l, grid_r = x0min - 18, x1max + 16
    passo = float(np.median([np.median(np.diff([t["cy"] for t in q[2]["tipos"]])) for q in quadros if len(q[2]["tipos"]) >= 3] or [17]))
    primeira = float(np.median([q[2]["tipos"][0]["cy"] for q in quadros if q[2]["tipos"]]))
    janelas, avisos = [], []
    for gi, grp in enumerate(grupos):
        esq = [q for q in grp if q[2]["hb"] and q[2]["hb"][0] <= x0min + 3 and len(q[2]["tipos"]) >= 3]
        dirt = [q for q in grp if q[2]["hb"] and q[2]["hb"][1] >= x1max - 3]
        meio = [q for q in grp if q[2]["tipos"] and q[2]["hb"] and q[2]["hb"][0] > x0min + 3]
        if not esq:
            if len(grp) >= 4:
                avisos.append(f"bloco {gi + 1}: nao tem a visao da ESQUERDA (colunas Parte do historico/Tipo): role a barra horizontal ate o inicio.")
            continue
        q_e = max(esq, key=lambda q: len(q[2]["tipos"]))
        tipos_e = q_e[2]["tipos"]
        tipo_x0 = float(np.median([t["x0"] for t in tipos_e])) - 3
        ref = q_e[2]
        nvis = int((ref["y_h"] - 8 - (primeira + passo / 2)) / passo) + 1
        cys = {k: primeira + k * passo for k in range(nvis)}
        linhas = {}
        for k in range(nvis):
            y = cys[k]
            tt, _ = ler_celula(q_e[1], tipo_x0, tipo_x0 + 56, y - passo / 2 + 1, y + passo / 2 - 1, texto=False)
            w = norm(tt).replace(" ", "")
            m = difflib.get_close_matches(w, list(TIPOS), n=1, cutoff=0.7) if w else []
            if m:
                linhas[k] = dict(parte="", tipo=TIPOS[m[0]], cod="", contra="", hist="", conf=1.0)
        ks = sorted(linhas)
        if not ks:
            continue
        for k in ks:
            y = cys[k]
            linhas[k]["parte"], c = ler_celula(q_e[1], grid_l + 1, tipo_x0, y - passo / 2 + 1, y + passo / 2 - 1)
            linhas[k]["conf"] = min(linhas[k]["conf"], c if c else 0.0)
        # meio: codigo + contrapartida
        if meio:
            # o quadro do meio que mostra mais linhas com numeros de codigo
            melhor = None
            for q in meio:
                tps = q[2]["tipos"]
                x_t0 = float(np.median([t["x0"] for t in tps]))
                n_dig = 0; dig_x = []
                for t in tps[:6]:
                    bx = _caixas_da_linha(q[1], t["cy"], passo, x_t0 + 55, grid_r)
                    for x, txt in bx:
                        if re.match(r"^\d{1,5}", txt):
                            n_dig += 1; dig_x.append(x); break
                if melhor is None or n_dig > melhor[0]:
                    melhor = (n_dig, q, dig_x, x_t0)
            n_dig, q_m, dig_x, x_t0 = melhor
            if n_dig:
                hist_x = _moda_ultimo(q_m[1], [t["cy"] for t in q_m[2]["tipos"]], passo, x_t0 + 55, grid_r) or (x_t0 + 447)
                cod_x0 = min(dig_x) - 6
                for k in ks:
                    y = cys[k]
                    corpo, c2 = ler_celula(q_m[1], cod_x0, hist_x - 1, y - passo / 2 + 1, y + passo / 2 - 1, texto=False)
                    linhas[k]["cod"], linhas[k]["contra"] = separar_codigo(corpo)
            else:
                avisos.append(f"bloco {gi + 1}: nao achei a coluna do Codigo na visao do meio.")
        elif len(grp) >= 4:
            avisos.append(f"bloco {gi + 1}: nao tem a visao do MEIO (colunas Codigo/Contrapartida): pare a barra horizontal no meio.")
        # direita: historico
        if dirt:
            q_d = max(dirt, key=lambda q: len(q[2]["caixas"]))
            hx = _moda_ultimo(q_d[1], [cys[k] for k in ks], passo, grid_l, grid_r)
            if hx:
                for k in ks:
                    h, c3 = ler_celula(q_d[1], hx + 1, grid_r - 1, cys[k] - passo / 2 + 1, cys[k] + passo / 2 - 1)
                    linhas[k]["hist"] = h
                    linhas[k]["conf"] = min(linhas[k]["conf"], c3 if c3 else 0.0)
            else:
                avisos.append(f"bloco {gi + 1}: nao achei a coluna do Historico contabil na visao da direita.")
        elif len(grp) >= 4:
            avisos.append(f"bloco {gi + 1}: nao tem a visao da DIREITA (Historico contabil): leve a barra horizontal ate o fim.")
        janelas.append([linhas[k] for k in ks])
        log(f"  bloco {gi + 1}: {len(ks)} linhas (esq {len(esq)} / meio {len(meio)} / dir {len(dirt)} quadros)")
    return janelas, avisos


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
    n_quadros, n_ignorados = 0, 0
    # 1) todos os quadros distintos (a rolagem continua tambem vale: a tela nao "borra")
    todos = list(iterar_quadros(a.origem, a.passo, estavel=1e9, minimo_mudanca=0.3))
    n_quadros = len(todos)
    print(f"{n_quadros} quadros distintos no video")
    ref = None
    for nome, img in todos[:40]:
        ref = info_quadro(img)
        if ref:
            break
    if ref is None:
        sys.exit("Nao encontrei a grade de regras em nenhum quadro. Confira se a tela 'Configuracao para Contabilizar Extrato Bancario' esta visivel na gravacao.")
    cols, primeiro, janelas, avisos = None, todos[0][1], [], []
    if ref["hb"]:
        print("Janela NAO maximizada: juntando as visoes esquerda / meio / direita de cada bloco...")
        meta = [(nome, img, barras(img, ref)) for nome, img in todos]
        hbs = [m[2]["hb"] for m in meta if m[2]["hb"]]
        x0min, x1max = min(h[0] for h in hbs), max(h[1] for h in hbs)
        # blocos = trechos com a barra vertical na mesma posicao
        blocos, atual, ant = [], [], "inicio"
        for m in meta:
            vb = m[2]["vb"]
            chave = None if vb is None else vb[0]
            mudou = ant != "inicio" and ((chave is None) != (ant is None) or (chave is not None and ant is not None and abs(chave - ant) > 3))
            if mudou and atual:
                blocos.append(atual); atual = []
            atual.append(m); ant = chave
        if atual:
            blocos.append(atual)
        grupos = []
        for bloco in blocos:
            com = [m for m in bloco if m[2]["hb"]]
            if not com:
                continue
            esc = {}
            lefts = [m for m in com if m[2]["hb"][0] <= x0min + 3]
            rights = [m for m in com if m[2]["hb"][1] >= x1max - 3]
            for lista in (lefts, rights):
                for j in range(min(3, len(lista))):   # alguns candidatos espalhados no tempo; o OCR escolhe o melhor
                    m = lista[int(len(lista) * j / min(3, len(lista)))]
                    esc[m[0]] = m
            ordem = sorted(com, key=lambda m: m[2]["hb"][0])
            for j in range(1, 6):   # alguns quadros intermediarios (visao do meio)
                m = ordem[min(len(ordem) - 1, int(len(ordem) * j / 6))]
                esc[m[0]] = m
            grupos.append([(n, im, info_quadro(im, ref)) for (n, im, _) in esc.values()])
            print(f"  bloco {len(grupos)}: {len(bloco)} quadros, {len(esc)} lidos ({time.time() - t0:.0f}s)", end="\r")
        print()
        janelas, avisos = processar_multivisao(grupos, x0min, x1max)
    else:
        print("Janela maximizada: lendo as 6 colunas de cada tela...")
        for nome, img in iterar_quadros(a.origem, a.passo):
            info = info_quadro(img)
            if not info:
                n_ignorados += 1
                continue
            grade = achar_grade(info["caixas"])
            if not grade:
                continue
            if cols is None:
                cols, erro = calibrar(img, grade, manual)
                if not cols:
                    print("Aviso:", erro)
                    continue
                primeiro = img.copy()
                print("Colunas detectadas:", cols)
            linhas = ler_linhas(img, cols, grade)
            if linhas:
                janelas.append(linhas)
    if not janelas:
        sys.exit("Nao consegui ler nenhuma regra. " + " ".join(avisos))

    geral, avisos2 = juntar(janelas)
    avisos += avisos2
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
