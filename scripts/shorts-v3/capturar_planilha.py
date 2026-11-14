"""Shorts v3.5 — captura da TELA REAL da planilha Lucro & Caixa no LibreOffice Calc (ferramenta local de autoria).

Ensaio real 43629467444 (júri Gemini real, prova 6,8): "são exibidos apenas cards vetoriais isolados simulando células,
sem mostrar a tela real da planilha (linhas, colunas, abas e software funcionando de verdade)". Aqui o próprio Calc é
aberto numa tela virtual (Xvfb), a planilha ORIGINAL (sha256 conferido) recebe as entradas da proveniência pela API do
LibreOffice (UNO), é recalculada, a célula é selecionada e a tela é fotografada (ImageMagick import). Duas capturas
por célula, sem retoque de pixels — só recorte:
  tela-<nome>.png    contexto: barra de fórmulas com a fórmula real, letras das colunas, números das linhas, abas,
                     barra de status, zoom 300%, 1080 px; + tela-<nome>-resto.png;
  celula-<nome>.png  close-up: a mesma célula selecionada a 400% (faixa das letras das colunas + linha 5), recortada
                     em torno do valor para que ele fique legível no celular.
Uso: Xvfb (tela 1400x1800) + soffice escutando em 2002, com LANG=pt_BR.UTF-8 (formato R$ e vírgula) (ver tests/media); python3 capturar_planilha.py ORIGINAL.xlsx PROVENIENCIA.json SAIDA/
Não roda no CI: as imagens geradas são versionadas e conferidas por hash (manifesto.json)."""
import hashlib, json, os, subprocess, sys, time
import uno
from com.sun.star.beans import PropertyValue
from PIL import Image

LARGURA_JANELA, ALTURA_CONTEXTO, ALTURA_PERTO = 1400, 1720, 760
SEL = (128, 0, 0)  # cor do cabeçalho da coluna/linha selecionada no Calc (tema padrão)
# contexto: da barra de fórmulas (nome da célula + fórmula) até a barra de status, sem menus/ferramentas nem painel lateral
# v3.6 (júri real 9,1, ensaio 43646726494: "terço inferior vazio" e "cabeçalhos pequenos"): tela a 300%, 1080 de largura
# (sangra a largura do Short) e alta o bastante para descer até a borda de baixo; dividida em DUAS imagens reais:
# tela-<nome>.png (barra de fórmulas até a linha 6 — a prova, medida por NCC) e tela-<nome>-resto.png (só a grade
# das linhas seguintes, sem texto — continuação real que fica sob a interface do Shorts).
CORTE_TELA = (0, 80, 1080, ALTURA_CONTEXTO); ZOOM_TELA = 300; ROTULO_LINHAS = 33; RODAPE_CALC = 62

def _p(n, v):
    p = PropertyValue(); p.Name = n; p.Value = v; return p

def faixa_selecionada(im, eixo, fixo, ini, fim):
    """Extensão contígua de pixels na cor de seleção ao longo de um eixo (cabeçalho de coluna ou de linha)."""
    px = im.load(); achados = [i for i in range(ini, fim) if px[(i, fixo) if eixo == "x" else (fixo, i)][:3] == SEL]
    if not achados: raise SystemExit("captura_sem_selecao_visivel")
    return min(achados), max(achados) + 1

def main(original, prov_path, saida):
    prov = json.load(open(prov_path, encoding="utf-8"))
    if hashlib.sha256(open(original, "rb").read()).hexdigest() != prov["sha256_planilha"]: raise SystemExit("planilha_original_divergente")
    ctx = uno.getComponentContext(); res = ctx.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", ctx)
    for _ in range(60):
        try: rctx = res.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext"); break
        except Exception: time.sleep(1)
    desk = rctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", rctx)
    doc = desk.loadComponentFromURL(uno.systemPathToFileUrl(os.path.abspath(original)), "_blank", 0, (_p("Hidden", False),))
    try:
        sh = doc.Sheets.getByName(prov["aba"]); linha = prov["linha"]
        cab = {sh.getCellByPosition(c, 2).getString(): c for c in range(0, 30)}
        for nome, v in prov["entradas"].items():  # só entradas; os resultados são calculados pela própria planilha
            cel = sh.getCellByPosition(cab[nome], linha - 1)
            cel.setString(v) if isinstance(v, str) else cel.setValue(v)
        doc.calculateAll()
        for nome_res, esperado in prov["resultados_calculados_pela_planilha"].items():
            real = sh.getCellByPosition(cab[nome_res], linha - 1)
            ok = real.getString() == esperado if isinstance(esperado, str) else abs(real.getValue() - esperado) < 1e-9
            if not ok: raise SystemExit("recalculo_divergente:" + nome_res)
        ctrl = doc.CurrentController; ctrl.setActiveSheet(sh); win = ctrl.Frame.ContainerWindow; ctrl.ZoomType = 3
        # aquecimento: a 1ª captura saía com a barra de status da aba anterior ("Sheet 1 of 13"); a tela precisa
        # repintar a aba ativa e a seleção antes de fotografar
        ctrl.select(sh.getCellRangeByName("A5")); win.setPosSize(0, 0, LARGURA_JANELA, ALTURA_CONTEXTO, 15); time.sleep(4)
        out = {}
        for nome, c in prov["celulas"].items():
            cel = sh.getCellRangeByName(c["celula"]); col = cel.CellAddress.Column
            if sh.getCellByPosition(col, linha - 1).getString() != c["valor_exibido"]: raise SystemExit("valor_exibido_divergente:" + nome)
            ctrl.select(cel)
            win.setPosSize(0, 0, LARGURA_JANELA, ALTURA_CONTEXTO, 15); ctrl.ZoomValue = ZOOM_TELA
            ctrl.setFirstVisibleColumn(max(0, col - 1)); ctrl.setFirstVisibleRow(2)  # a partir do cabeçalho (linha 3)
            ctrl.select(sh.getCellRangeByName("A1")); time.sleep(1); ctrl.select(cel)  # barra de status atualizada para ESTA célula
            ctrl.setFirstVisibleColumn(max(0, col - 1)); ctrl.setFirstVisibleRow(2)  # a seleção rola a tela: fixa de novo; time.sleep(2.5)
            tmp = os.path.join(saida, f".raw-{nome}.png"); subprocess.run(["import", "-window", "root", tmp], check=True)
            tela = Image.open(tmp).convert("RGB"); _, y1t = faixa_selecionada(tela, "y", 10, 100, ALTURA_CONTEXTO - 80)  # linha 5
            corte = y1t + (y1t - faixa_selecionada(tela, "y", 10, 100, ALTURA_CONTEXTO - 80)[0])  # + altura de 1 linha (linha 6)
            tela = tela.crop(CORTE_TELA); h = corte - CORTE_TELA[1]
            tela.crop((0, 0, tela.width, h)).save(os.path.join(saida, f"tela-{nome}.png"))
            # continuação: só a GRADE das linhas seguintes (sem números de linha, abas nem barra de status) — nada de texto
            # abaixo de y=1470, onde fica a interface do Shorts
            tela.crop((ROTULO_LINHAS, h, tela.width, tela.height - RODAPE_CALC)).save(os.path.join(saida, f"tela-{nome}-resto.png"))
            win.setPosSize(0, 0, LARGURA_JANELA, ALTURA_PERTO, 15); ctrl.ZoomValue = 400
            ctrl.setFirstVisibleColumn(col); ctrl.setFirstVisibleRow(linha - 1); time.sleep(2.5)
            subprocess.run(["import", "-window", "root", tmp], check=True); im = Image.open(tmp).convert("RGB")
            x0, x1 = faixa_selecionada(im, "x", 118, 30, LARGURA_JANELA - 60)   # letra da coluna selecionada
            y0, y1 = faixa_selecionada(im, "y", 10, 100, ALTURA_PERTO - 60)    # número da linha selecionada
            topo = 110  # faixa das letras das colunas, logo acima da linha visível
            corte = (max(x0, x1 - 560), topo, min(LARGURA_JANELA - 60, x1 + 2), y1 + 14)
            im.crop(corte).save(os.path.join(saida, f"celula-{nome}.png")); os.remove(tmp)
            out[nome] = {"celula": c["celula"], "corte_perto": corte}
        print(json.dumps(out, ensure_ascii=False))
    finally:
        doc.close(True)

if __name__ == "__main__":
    main(*sys.argv[1:4])
