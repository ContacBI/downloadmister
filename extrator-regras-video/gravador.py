#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gravador de tela para o extrator de regras do Dominio.

Em vez de gravar um video (que comprime e borra o texto), ele tira "fotos" da tela inteira e guarda as
que MUDARAM. Ao terminar, chama o extrator.

  1. Abra no Dominio a tela "Configuracao para Contabilizar Extrato Bancario" (pode deixar a janela do tamanho normal).
  2. Preencha o nome da empresa e o codigo do banco, clique em "Iniciar gravacao".
  3. Arraste a barra de rolagem HORIZONTAL da esquerda ate a direita, devagar. Se a lista tiver barra vertical:
     role umas 10 a 15 linhas e arraste a horizontal de volta (zigue-zague), ate chegar ao fim da lista.
  4. Clique em "Parar e extrair". A pasta com os arquivos abre no fim.
"""
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime

import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))


class Capturador:
    """Guarda so as capturas novas e paradas. `captura` devolve um array BGR (altura x largura x 3)."""

    def __init__(self, captura, pasta, intervalo=0.15, estavel=1e9, mudanca=0.3, limite=1500):
        self.captura, self.pasta, self.intervalo = captura, pasta, intervalo
        self.estavel, self.mudanca, self.limite = estavel, mudanca, limite
        self.guardadas = 0
        self._parar = threading.Event()
        self._thread = None

    @staticmethod
    def _pequeno(img):
        import cv2
        return cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (480, 270)).astype(np.float32)

    def passo(self, anterior, ultimo):
        """Uma captura. Devolve (nova_anterior, novo_ultimo)."""
        import cv2
        img = self.captura()
        g = self._pequeno(img)
        parado = anterior is not None and float(np.abs(g - anterior).mean()) < self.estavel
        if parado and (ultimo is None or float(np.abs(g - ultimo).mean()) > self.mudanca) and self.guardadas < self.limite:
            self.guardadas += 1
            cv2.imwrite(os.path.join(self.pasta, f"q{self.guardadas:04d}.png"), img)
            ultimo = g
        return g, ultimo

    def _loop(self):
        anterior = ultimo = None
        while not self._parar.is_set():
            try:
                anterior, ultimo = self.passo(anterior, ultimo)
            except Exception as e:  # uma captura falhada nao derruba a gravacao
                print("captura falhou:", e)
            time.sleep(self.intervalo)

    def iniciar(self):
        os.makedirs(self.pasta, exist_ok=True)
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def parar(self):
        self._parar.set()
        if self._thread:
            self._thread.join(timeout=3)


def captura_tela_inteira():
    import mss
    import cv2
    sct = mss.mss()
    mon = sct.monitors[1]  # monitor principal

    def captura():
        return cv2.cvtColor(np.array(sct.grab(mon)), cv2.COLOR_BGRA2BGR)
    return captura


def janela():
    import tkinter as tk
    from tkinter import filedialog, scrolledtext

    raiz = tk.Tk()
    raiz.title("Gravador de regras do Dominio")
    raiz.attributes("-topmost", True)
    raiz.geometry("430x420+20+20")
    estado = dict(cap=None, pasta=None, t0=None)

    def linha(rotulo, valor=""):
        f = tk.Frame(raiz); f.pack(fill="x", padx=8, pady=2)
        tk.Label(f, text=rotulo, width=14, anchor="w").pack(side="left")
        e = tk.Entry(f); e.insert(0, valor); e.pack(side="left", fill="x", expand=True)
        return e
    e_emp = linha("Empresa:")
    e_bco = linha("Codigo do banco:", "11")
    e_id = linha("ID da conta (HUB):")
    tk.Label(raiz, text="(ID da conta e opcional: vazio = vale para todas as contas da empresa)", fg="#555").pack(anchor="w", padx=8)

    lbl = tk.Label(raiz, text="Pronto. Maximize a janela do Dominio antes de gravar.", fg="#0a5")
    lbl.pack(pady=4)
    log = scrolledtext.ScrolledText(raiz, height=12, state="disabled", font=("Consolas", 8))

    def escrever(txt):
        log.configure(state="normal"); log.insert("end", txt); log.see("end"); log.configure(state="disabled")

    def atualizar():
        if estado["cap"]:
            dec = int(time.time() - estado["t0"])
            lbl.config(text=f"GRAVANDO {dec // 60:02d}:{dec % 60:02d}  |  {estado['cap'].guardadas} telas guardadas", fg="#c00")
            raiz.after(500, atualizar)

    def iniciar():
        if not e_emp.get().strip():
            lbl.config(text="Preencha o nome da empresa.", fg="#c00"); return
        nome = re.sub(r"[^A-Za-z0-9]+", "_", e_emp.get().strip()).strip("_")
        estado["pasta"] = os.path.join(AQUI, "capturas", f"{nome}_{datetime.now():%Y%m%d_%H%M%S}")
        estado["cap"] = Capturador(captura_tela_inteira(), estado["pasta"])
        estado["cap"].iniciar(); estado["t0"] = time.time()
        b_ini.config(state="disabled"); b_par.config(state="normal")
        atualizar()

    def extrair(origem):
        cmd = [sys.executable, os.path.join(AQUI, "extrair_regras.py"), origem, "--empresa", e_emp.get().strip(), "--banco", e_bco.get().strip()]
        if e_id.get().strip():
            cmd += ["--conta-id", e_id.get().strip()]
        saida = os.path.join(AQUI, "saidas", re.sub(r"[^A-Za-z0-9]+", "_", e_emp.get().strip()).strip("_") + f"_banco{e_bco.get().strip()}")
        cmd += ["--saida", saida]
        escrever("> " + " ".join(cmd) + "\n")

        def roda():
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
            for l in p.stdout:
                raiz.after(0, escrever, l.replace("\r", "\n"))
            p.wait()
            raiz.after(0, lambda: lbl.config(text="Pronto! Abrindo a pasta de resultados." if p.returncode == 0 else "Falhou: veja o registro abaixo.", fg="#0a5" if p.returncode == 0 else "#c00"))
            if p.returncode == 0 and os.name == "nt":
                os.startfile(saida)
            raiz.after(0, lambda: (b_ini.config(state="normal"), b_par.config(state="disabled")))
        threading.Thread(target=roda, daemon=True).start()

    def parar():
        estado["cap"].parar(); n = estado["cap"].guardadas; estado["cap"] = None
        lbl.config(text=f"Parou. {n} telas guardadas. Lendo (pode levar alguns minutos)...", fg="#06c")
        b_par.config(state="disabled")
        extrair(estado["pasta"])

    def de_video():
        arq = filedialog.askopenfilename(title="Escolha a gravacao", filetypes=[("Video", "*.mp4 *.avi *.mkv *.mov"), ("Todos", "*.*")])
        if arq and e_emp.get().strip():
            lbl.config(text="Lendo o video (pode levar alguns minutos)...", fg="#06c"); b_ini.config(state="disabled"); extrair(arq)
        elif arq:
            lbl.config(text="Preencha o nome da empresa primeiro.", fg="#c00")

    f = tk.Frame(raiz); f.pack(pady=4)
    b_ini = tk.Button(f, text="● Iniciar gravacao", command=iniciar, bg="#2a7", fg="white", width=18); b_ini.pack(side="left", padx=4)
    b_par = tk.Button(f, text="■ Parar e extrair", command=parar, bg="#c33", fg="white", width=18, state="disabled"); b_par.pack(side="left", padx=4)
    tk.Button(raiz, text="Ler um video ja gravado...", command=de_video).pack(pady=2)
    log.pack(fill="both", expand=True, padx=8, pady=6)
    raiz.mainloop()


if __name__ == "__main__":
    janela()
