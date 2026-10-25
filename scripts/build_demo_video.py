#!/usr/bin/env python3
"""Render the silent, captioned demo of the sales site from the APPROVED preview images only.

Honesty and authorisation rules (docs/design/sales-site-identity.md §12 and §14):
  * inputs are exactly the committed preview images (assets/previews/*.webp) listed in
    docs/evidence/sales-ux/previews-manifest.json; their SHA-256 is checked before rendering;
  * every page is shown at its native size or smaller (scale <= 1: never enlarged), with a slow pan
    on tall pages; no other image, no stock footage, no voice, no music;
  * the persistent top bar says "Demonstração com páginas reais do material";
  * captions (WebVTT, pt-BR) say what the buyer receives; they repeat the preview captions.

Outputs (committed, then content-hashed by the build): assets/video/zevanory-demo.{mp4,webm,vtt} and
assets/video/zevanory-demo-poster.webp, plus the provenance manifest
docs/evidence/sales-ux/demo-video-manifest.json. Run in the cloud: python3 scripts/build_demo_video.py
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREVIEWS = json.loads((ROOT / "docs/evidence/sales-ux/previews-manifest.json").read_text(encoding="utf-8"))
OUT_DIR = ROOT / "assets" / "video"
MANIFEST = ROOT / "docs/evidence/sales-ux/demo-video-manifest.json"
W, H, BAR, FPS = 1280, 720, 56, 24
LABEL = "Demonstração com páginas reais do material"
PAPEL, TINTA, BALCAO = "0xEEF2F5", "0x0E1A2B", "0x0E1A2B"
INTRO_S, SHOT_S, OUTRO_S, FADE_S = 4.0, 5.5, 5.0, 0.4
POSTER_ONLY = "--poster-only" in sys.argv

# (preview id, product shown in the bar, caption). Captions restate the approved preview captions.
SHOTS = [
    ("manual-lucro-capa", "Lucro & Caixa", "Lucro & Caixa: capa do manual. Ela diz o que o produto resolve e a ordem das abas da planilha."),
    ("manual-lucro-modulo-1", "Lucro & Caixa", "Página interna: módulos 1 e 2, faturamento x resultado e mapa de custos, com exemplo fictício e atividade."),
    ("planilha-lucro-painel", "Lucro & Caixa", "Trecho da planilha: o Painel de Decisão. Nesta prévia, a coluna de leitura está oculta."),
    ("manual-vendas-capa", "Vendas na Prática", "Vendas na Prática: capa com o público, o formato e as oito aulas, de B1 a B8."),
    ("manual-vendas-aula-b1", "Vendas na Prática", "Aula B1: defina uma oferta que você consegue cumprir. Objetivo, exemplo comentado, exercício e como conferir."),
    ("planilha-vendas-oportunidades", "Vendas na Prática", "Planilha comercial, aba Oportunidades: origem, etapa, resultado, proposta e próxima ação."),
    ("manual-ia-capa", "IA na Prática", "IA na Prática: capa com o público, o formato e as oito aulas, de A1 a A8."),
    ("manual-ia-aula-a1", "IA na Prática", "Aula A1: escolha uma rotina que vale organizar e meça o tempo completo, com a revisão incluída."),
    ("planilha-ia-orcamento", "IA na Prática", "Planilha, aba Orçamento: item, quantidade, unitário, subtotal e conferência."),
    ("plano-30-dias-capa", "Negócio Completo", "Negócio Completo: o Plano integrado de 30 dias, com o modo de uso e a semana 1."),
    ("plano-30-dias-semana-2", "Negócio Completo", "Semana 2 do plano: ações diárias de vendas e acompanhamento, cada uma com critério de conclusão."),
    ("painel-decisao-integrada", "Negócio Completo", "Painel de Decisão Integrada: as colunas por produto ou serviço, do mesmo período."),
]
INTRO = ("O que vem dentro dos materiais ZEVANORY", "Sem som. Legendas em português.",
         "Demonstração com páginas reais do material: capas, uma página interna e um trecho de planilha de cada produto.")
OUTRO = ("Tudo chega por e-mail, num arquivo .zip", "Link pessoal válido por 72 horas e para um download.",
         "Tudo chega por e-mail, num arquivo .zip, em link pessoal válido por 72 horas e para um download.")


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(args: list[str]) -> None:
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("ffmpeg failed: " + " ".join(args)[:400] + "\n" + r.stderr[-2000:])


def ttf(woff2: Path, out: Path) -> Path:
    from fontTools.ttLib import TTFont
    f = TTFont(str(woff2))
    f.flavor = None
    f.save(str(out))
    return out


def ts(t: float) -> str:
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


def main() -> int:
    images = {i["id"]: i for i in PREVIEWS["images"]}
    for pid, _, _ in SHOTS:
        i = images[pid]
        f = ROOT / i["webp"]["file"]
        if sha(f) != i["webp"]["sha256"]:
            raise SystemExit(f"{pid}: preview hash differs from the approved manifest")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        display = ttf(ROOT / "assets/fonts/archivo.woff2", tmp / "archivo.ttf")
        body = ttf(ROOT / "assets/fonts/atkinson-hyperlegible-next.woff2", tmp / "atkinson.ttf")

        def text_file(name: str, text: str) -> str:
            p = tmp / name
            p.write_text(text, encoding="utf-8")
            return str(p).replace(":", r"\:")

        def bar(product: str) -> str:
            lab, prod = text_file("bar-label.txt", "ZEVANORY  ·  " + LABEL), text_file("bar-" + hashlib.sha256(product.encode()).hexdigest()[:8] + ".txt", product)
            return (f"drawbox=x=0:y=0:w={W}:h={BAR}:color={BALCAO}:t=fill,"
                    f"drawtext=fontfile={body}:textfile={lab}:fontcolor=white:fontsize=22:x=28:y=(56-th)/2,"
                    f"drawtext=fontfile={display}:textfile={prod}:fontcolor=0xFFC72C:fontsize=24:x=w-tw-28:y=(56-th)/2")

        segs = []
        # Intro / outro cards: typography only (no image).
        for name, (title, sub, _), dur in (("intro", INTRO, INTRO_S), ("outro", OUTRO, OUTRO_S)):
            t1, t2 = text_file(name + "1.txt", title), text_file(name + "2.txt", sub)
            vf = (bar("vendas.zevanory.api.br") + f",drawtext=fontfile={display}:textfile={t1}:fontcolor={TINTA}:fontsize=52:x=(w-tw)/2:y=h/2-70,"
                  f"drawtext=fontfile={body}:textfile={t2}:fontcolor=0x4A5568:fontsize=30:x=(w-tw)/2:y=h/2+10,"
                  f"fade=t=in:st=0:d={FADE_S}:color={PAPEL},fade=t=out:st={dur - FADE_S}:d={FADE_S}:color={PAPEL}")
            out = tmp / f"{name}.mkv"
            run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c={PAPEL}:s={W}x{H}:r={FPS}:d={dur}",
                 "-vf", vf, "-c:v", "ffv1", str(out)])
            segs.append((name, out, dur))
        intro, outro = segs
        # Poster: the typography-only intro card (title + "Demonstração com páginas reais do material"), taken from
        # the lossless segment so it stays a few KB: it is fetched with the page (poster attribute), so it must be light.
        poster = OUT_DIR / "zevanory-demo-poster.webp"
        run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "2.0", "-i", str(intro[1]), "-frames:v", "1", "-vf", "scale=960:540:flags=lanczos",
             "-c:v", "libwebp", "-quality", "60", "-compression_level", "6", "-map_metadata", "-1", str(poster)])
        mp4, webm = OUT_DIR / "zevanory-demo.mp4", OUT_DIR / "zevanory-demo.webm"
        segs = [intro] if not POSTER_ONLY else []
        area = H - BAR - 32  # 16 px margin above and below the page
        for n, (pid, product, _) in enumerate(SHOTS if not POSTER_ONLY else []):
            i = images[pid]
            iw, ih = i["width"], i["height"]
            scale = min(1.0, (W - 64) / iw)  # never enlarged; tall pages pan instead of shrinking
            sw, sh = int(iw * scale) // 2 * 2, int(ih * scale) // 2 * 2
            if sh > area:  # pan from the top to the bottom of the page
                y = f"{BAR + 16}-({sh - area})*min(1\\,max(0\\,(t-0.6)/({SHOT_S}-1.4)))"
            else:
                y = f"{BAR + 16 + (area - sh) // 2}"
            out = tmp / f"shot{n:02d}.mkv"
            fc = (f"[1:v]scale={sw}:{sh}:flags=lanczos,format=rgba[pg];"
                  f"[0:v][pg]overlay=x={(W - sw) // 2}:y='{y}':eval=frame,{bar(product)},"
                  f"fade=t=in:st=0:d={FADE_S}:color={PAPEL},fade=t=out:st={SHOT_S - FADE_S}:d={FADE_S}:color={PAPEL}[v]")
            run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c={PAPEL}:s={W}x{H}:r={FPS}:d={SHOT_S}",
                 "-loop", "1", "-t", str(SHOT_S), "-i", str(ROOT / i["webp"]["file"]),
                 "-filter_complex", fc, "-map", "[v]", "-r", str(FPS), "-c:v", "ffv1", str(out)])
            segs.append((pid, out, SHOT_S))
        if POSTER_ONLY:  # keep the committed MP4/WebM; refresh poster, captions and manifest only
            segs = []
        else:
            segs.append(outro)
        lst = tmp / "list.txt"
        lst.write_text("".join(f"file '{p}'\n" for _, p, _ in segs), encoding="utf-8")
        joined = tmp / "joined.mkv"
        if segs:
            run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(joined)])
        # H.264 (main profile, yuv420p, faststart) and VP9; no audio track (silent by design).
        if segs:
          run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(joined), "-an", "-c:v", "libx264", "-preset", "veryslow", "-crf", "30",
             "-tune", "stillimage", "-profile:v", "main", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-map_metadata", "-1",
             "-fflags", "+bitexact", "-flags:v", "+bitexact", str(mp4)])
          run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(joined), "-an", "-c:v", "libvpx-vp9", "-crf", "42", "-b:v", "0",
             "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-pix_fmt", "yuv420p", "-map_metadata", "-1",
             "-fflags", "+bitexact", "-flags:v", "+bitexact", str(webm)])
    # Captions: one cue per segment.
    cues, t, shots = ["WEBVTT", ""], 0.0, []
    timeline = [("intro", INTRO[2], INTRO_S)] + [(pid, cap, SHOT_S) for pid, _, cap in SHOTS] + [("outro", OUTRO[2], OUTRO_S)]
    for n, (pid, cap, dur) in enumerate(timeline, 1):
        cues += [str(n), f"{ts(t + 0.2)} --> {ts(t + dur - 0.2)}", cap, ""]
        shots.append({"id": pid, "start_s": round(t, 2), "end_s": round(t + dur, 2), "caption": cap,
                      **({"source": images[pid]["webp"]["file"], "source_sha256": images[pid]["webp"]["sha256"],
                          "label": images[pid]["label"]} if pid in images else {"source": "typography only"})})
        t += dur
    vtt = OUT_DIR / "zevanory-demo.vtt"
    vtt.write_text("\n".join(cues), encoding="utf-8")
    ver = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.splitlines()[0]
    outputs = {k: {"file": p.relative_to(ROOT).as_posix(), "sha256": sha(p), "bytes": p.stat().st_size}
               for k, p in (("mp4", mp4), ("webm", webm), ("vtt", vtt), ("poster", poster))}
    MANIFEST.write_text(json.dumps({
        "schema": "zevanory.demo-video.v1",
        "label": LABEL,
        "generated_by": "scripts/build_demo_video.py",
        "renderer": ver,
        "authorization": "Same images as the approved previews (owner: 'AUTORIZO PRÉVIAS REAIS DOS PRODUTOS NO SITE'); "
                         "each shown at native size or smaller (never enlarged), nothing downloadable beyond the video.",
        "width": W, "height": H, "fps": FPS, "duration_s": t, "audio": "none (silent by design)",
        "captions": {"file": outputs["vtt"]["file"], "srclang": "pt-BR", "kind": "captions"},
        "shots": shots, "outputs": outputs}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    total = outputs["mp4"]["bytes"] + outputs["webm"]["bytes"]
    print(f"DEMO_VIDEO duration={t}s mp4={outputs['mp4']['bytes']} webm={outputs['webm']['bytes']} poster={outputs['poster']['bytes']}")
    if max(outputs["mp4"]["bytes"], outputs["webm"]["bytes"]) >= 4 * 1024 * 1024:
        raise SystemExit("demo video over the 4 MB budget")
    return 0 if total else 1


if __name__ == "__main__":
    sys.exit(main())
