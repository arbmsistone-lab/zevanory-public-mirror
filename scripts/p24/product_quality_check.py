#!/usr/bin/env python3
"""P24 Qualidade do produto: página de venda x material entregue (Roteiro Mestre v4.7, seção 5).

Gate determinístico, sem rede e sem segredo. Entradas versionadas no repositório:
  - sales-public/<slug>.html            páginas de venda (fonte das promessas)
  - data/p24/promise-map.json           promessa -> material entregue
  - data/p24/delivery-manifest.json     listagem catalogada dos zips (gerada por build_delivery_manifest.py)
  - data/p24/rubric.json                rubrica P24
  - worker/cloudflare-worker.recovered.mjs  catálogo do Worker (artifact_name e artifact_sha256)
  - data/products.json                  preço oficial

Reprova (exit 1) em falha objetiva:
  - promessa da página sem entrada no mapa (promessa sem entrega declarada);
  - entrada do mapa que não existe mais na página (mapa desatualizado);
  - arquivo prometido ausente do manifesto, ou que não abriu na conferência;
  - formato citado na promessa (PDF, DOCX, XLSX) sem arquivo desse formato;
  - SHA-256 do zip no manifesto diferente do catálogo do Worker;
  - componente "completo" de pacote que não é cópia byte a byte do produto avulso;
  - conta de economia de pacote que não fecha com data/products.json;
  - âncora temática ausente do arquivo indicado;
  - PDF sem marcação (tagged) ou planilha com erro de fórmula no recálculo.

Não reprova, mas registra como achado: promessas com revisão humana pendente ('review': 'REVISAO_HUMANA')
e recomendações de acessibilidade (título e idioma do PDF). O veredito P24 nunca é PASS enquanto houver
achado pendente ou a avaliação cega da rubrica (seção 6.1) não tiver sido feita.
"""
from __future__ import annotations

import argparse
import html as htmllib
import json
import re
import sys
import unicodedata
from pathlib import Path

SCHEMA_MAP = "zevanory-p24-promise-map/v1"
SCHEMA_MANIFEST = "zevanory-p24-delivery-manifest/v1"
SCHEMA_RUBRIC = "zevanory-p24-rubric/v1"
SCHEMA_REPORT = "zevanory-p24-report/v1"
SCHEMA_DEFECTS = "zevanory-p24-open-defects/v1"
FORMAT_WORDS = {"PDF": ".pdf", "DOCX": ".docx", "XLSX": ".xlsx"}


def norm_space(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def norm_anchor(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s)


def _strip_tags(fragment: str) -> str:
    return norm_space(htmllib.unescape(re.sub(r"<[^>]+>", "", fragment)))


def _li_items(ul_inner: str) -> list[str]:
    return [_strip_tags(x) for x in re.findall(r"<li[^>]*>(.*?)</li>", ul_inner, re.S)]


REGIONS = ("hero_receipt", "essentials", "scope_features", "method_cards", "offer_method")
# Regiões que toda página de produto precisa ter. Se a marcação mudar e uma delas sumir, o gate reprova em vez de
# extrair menos promessas sem avisar.
REQUIRED_REGIONS = ("hero_receipt", "essentials", "scope_features", "method_cards", "offer_method")


def extract_promises(page_html: str) -> dict[str, list[str]]:
    """Extrai as promessas da página nas regiões declaradas no mapa (marcação do #914 em diante)."""
    out: dict[str, list[str]] = {}
    m = re.search(r'<(?:aside|div) class="hero-panel receipt"[^>]*>.*?<ul class="outcome-list"[^>]*>(.*?)</ul>', page_html, re.S)
    out["hero_receipt"] = _li_items(m.group(1)) if m else []
    m = re.search(r'<div data-field="caracteristicas">.*?<dd>(.*?)</dd>', page_html, re.S)
    if m:
        text = _strip_tags(m.group(1)).rstrip(".")
        out["essentials"] = [norm_space(x) for x in text.split(";") if norm_space(x)]
    else:
        out["essentials"] = []
    out["scope_features"] = [_strip_tags(x) for x in re.findall(r'<article class="feature">.*?<h3>(.*?)</h3>', page_html, re.S)]
    out["method_cards"] = [_strip_tags(x) for x in re.findall(r'<article class="card">.*?<h3>(.*?)</h3>', page_html, re.S)]
    m = re.search(r'<div class="offer-main">(?:(?!</div>).)*?<ul>(.*?)</ul>', page_html, re.S)
    out["offer_method"] = _li_items(m.group(1)) if m else []
    return out


def parse_worker_catalog(worker_src: str) -> dict[str, dict[str, str]]:
    """Lê sku, artifact_name e artifact_sha256 de ZEVANORY_PRODUCTS no Worker."""
    block = re.search(r"ZEVANORY_PRODUCTS\s*=\s*Object\.freeze\(\[(.*?)\]\);", worker_src, re.S)
    if not block:
        raise ValueError("ZEVANORY_PRODUCTS não encontrado no Worker")
    catalog: dict[str, dict[str, str]] = {}
    for entry in re.findall(r"Object\.freeze\(\{(.*?)\}\)", block.group(1), re.S):
        sku = re.search(r'sku:\s*"([^"]+)"', entry)
        name = re.search(r'artifact_name:\s*"([^"]+)"', entry)
        sha = re.search(r'artifact_sha256:\s*"([0-9a-f]{64})"', entry)
        if sku and name and sha:
            catalog[sku.group(1)] = {"artifact_name": name.group(1), "artifact_sha256": sha.group(1)}
    return catalog


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def evaluate(root: Path, generated_at: str | None = None) -> dict:
    errors: list[str] = []
    findings: list[dict] = []
    defects: list[tuple[str, str, str, str]] = []
    pmap = _load(root / "data/p24/promise-map.json")
    manifest = _load(root / "data/p24/delivery-manifest.json")
    rubric = _load(root / "data/p24/rubric.json")
    registry = _load(root / "data/p24/open-defects.json")
    if registry.get("schema") != SCHEMA_DEFECTS:
        errors.append(f"open-defects: schema deve ser {SCHEMA_DEFECTS}")
    registered = {}
    for d in registry.get("defects", []):
        key = (d.get("product"), d.get("file"), d.get("kind"))
        if not all(key) or not d.get("registered_at") or not d.get("owner_action"):
            errors.append(f"open-defects: registro incompleto {key}")
        registered[key] = d
    products_json = _load(root / "data/products.json")
    catalog = parse_worker_catalog((root / "worker/cloudflare-worker.recovered.mjs").read_text(encoding="utf-8"))

    if pmap.get("schema") != SCHEMA_MAP:
        errors.append(f"promise-map: schema deve ser {SCHEMA_MAP}")
    if manifest.get("schema") != SCHEMA_MANIFEST:
        errors.append(f"manifest: schema deve ser {SCHEMA_MANIFEST}")
    if rubric.get("schema") != SCHEMA_RUBRIC:
        errors.append(f"rubric: schema deve ser {SCHEMA_RUBRIC}")

    price_by_slug = {p["slug"]: p["price"] for p in products_json.get("products", [])}
    sku_by_slug = {p["slug"]: p["sku"] for p in products_json.get("products", [])}
    man_products = manifest.get("products", {})
    report_products: dict[str, dict] = {}

    for slug, prod in pmap.get("products", {}).items():
        perr_start = len(errors)
        pdef_start = len(defects)
        sku = prod.get("sku")
        if sku_by_slug.get(slug) != sku:
            errors.append(f"{slug}: sku do mapa ({sku}) difere de data/products.json ({sku_by_slug.get(slug)})")
        mp = man_products.get(slug)
        if not mp:
            errors.append(f"{slug}: produto ausente do manifesto de entrega")
            continue
        cat = catalog.get(sku)
        if not cat:
            errors.append(f"{slug}: sku {sku} ausente do catálogo do Worker")
        else:
            if mp.get("artifact_sha256") != cat["artifact_sha256"]:
                errors.append(f"{slug}: SHA-256 do zip no manifesto ({mp.get('artifact_sha256')}) difere do catálogo do Worker ({cat['artifact_sha256']})")
            if mp.get("artifact_name") != cat["artifact_name"]:
                errors.append(f"{slug}: nome do zip no manifesto difere do catálogo do Worker")
        if mp.get("zip_integrity") != "ok":
            errors.append(f"{slug}: zip não passou no teste de integridade ({mp.get('zip_integrity')})")
        entries = {e["path"]: e for e in mp.get("entries", [])}

        page_path = root / prod["page"]
        page_promises = extract_promises(page_path.read_text(encoding="utf-8"))
        for region in REQUIRED_REGIONS:
            if not page_promises[region]:
                errors.append(f"{slug}: região de promessas '{region}' não encontrada na página (a marcação mudou? ajuste a extração antes de confiar no gate)")
        page_texts: list[str] = []
        for region in REGIONS:
            for t in page_promises[region]:
                if t not in page_texts:
                    page_texts.append(t)
        if not page_texts:
            errors.append(f"{slug}: nenhuma promessa extraída da página (extração quebrou?)")
        mapped = {norm_space(p["text"]): p for p in prod.get("promises", [])}
        ids = [p.get("id") for p in prod.get("promises", [])]
        if len(ids) != len(set(ids)):
            errors.append(f"{slug}: id de promessa repetido no mapa")
        for t in page_texts:
            if t not in mapped:
                errors.append(f"{slug}: PROMESSA SEM ENTREGA DECLARADA: '{t}' (adicione ao data/p24/promise-map.json com o material correspondente)")
        for t in mapped:
            if t not in page_texts:
                errors.append(f"{slug}: o mapa cita '{t}', que não está mais na página (mapa desatualizado)")

        rows = []
        for p in prod.get("promises", []):
            row = {"id": p["id"], "text": p["text"], "type": p["type"], "status": None, "evidence": []}
            row_err_start = len(errors)
            ptype = p["type"]
            if ptype == "deliverable":
                files = p.get("files") or []
                if not files:
                    errors.append(f"{slug}:{p['id']}: entregável sem arquivo")
                for f in files:
                    e = entries.get(f)
                    if not e:
                        errors.append(f"{slug}:{p['id']}: arquivo prometido ausente do zip: {f}")
                        continue
                    if not e.get("open", {}).get("ok"):
                        errors.append(f"{slug}:{p['id']}: arquivo não abre: {f} ({e.get('open', {}).get('detail')})")
                    row["evidence"].append({"file": f, "sha256": e["sha256"], "bytes": e["size"], "open": e.get("open", {}).get("detail")})
                for word, ext in FORMAT_WORDS.items():
                    if re.search(rf"\b{word}\b", p["text"]) and not any(f.lower().endswith(ext) for f in files):
                        errors.append(f"{slug}:{p['id']}: a promessa cita {word}, mas nenhum arquivo {ext} foi mapeado")
            elif ptype == "component":
                comp = man_products.get(p.get("component", ""))
                prefix = p.get("prefix", "")
                if not comp:
                    errors.append(f"{slug}:{p['id']}: componente {p.get('component')} ausente do manifesto")
                else:
                    missing, diff = [], []
                    for ce in comp.get("entries", []):
                        inner = entries.get(prefix + ce["path"])
                        if not inner:
                            missing.append(ce["path"])
                        elif inner["sha256"] != ce["sha256"]:
                            diff.append(ce["path"])
                        elif not inner.get("open", {}).get("ok"):
                            errors.append(f"{slug}:{p['id']}: arquivo do componente não abre: {prefix + ce['path']}")
                    if missing:
                        errors.append(f"{slug}:{p['id']}: componente incompleto, faltam {missing}")
                    if diff:
                        errors.append(f"{slug}:{p['id']}: arquivos diferentes do produto avulso: {diff}")
                    row["evidence"].append({"component": p["component"], "prefix": prefix, "files_identical": len(comp.get("entries", [])) - len(missing) - len(diff), "files_expected": len(comp.get("entries", []))})
            elif ptype == "price":
                comps = p.get("components") or []
                total = sum(price_by_slug.get(c, 0) for c in comps)
                own = price_by_slug.get(slug)
                nums = [int(x) for x in re.findall(r"R\$\s*(\d+)", p["text"])]
                if len(nums) != 2 or own is None or any(c not in price_by_slug for c in comps):
                    errors.append(f"{slug}:{p['id']}: promessa de preço não verificável")
                else:
                    economy, separate = nums
                    if separate != total or economy != total - own:
                        errors.append(f"{slug}:{p['id']}: conta não fecha (avulsos {total}, pacote {own}, economia {total - own}; página diz {economy} e {separate})")
                    row["evidence"].append({"source": "data/products.json", "separate_total": total, "bundle_price": own, "economy": total - own})
            elif ptype not in ("content", "outcome"):
                errors.append(f"{slug}:{p['id']}: tipo desconhecido {ptype}")

            for ev in p.get("evidence", []) or []:
                e = entries.get(ev.get("file", ""))
                if not e:
                    errors.append(f"{slug}:{p['id']}: arquivo de evidência ausente do zip: {ev.get('file')}")
                    continue
                counts = e.get("anchors", {})
                hits = {}
                for a in ev.get("anchors", []):
                    key = norm_anchor(a)
                    c = counts.get(key)
                    if c is None:
                        errors.append(f"{slug}:{p['id']}: âncora '{key}' não foi medida no manifesto para {ev['file']} (regenere o manifesto)")
                    elif c < 1:
                        errors.append(f"{slug}:{p['id']}: âncora '{key}' ausente de {ev['file']}")
                    hits[key] = c
                row["evidence"].append({"file": ev["file"], "anchors": hits})
            if ptype in ("content", "outcome") and not p.get("evidence"):
                errors.append(f"{slug}:{p['id']}: promessa de conteúdo sem evidência")

            if len(errors) > row_err_start:
                row["status"] = "FAIL"
            elif p.get("review") == "REVISAO_HUMANA":
                row["status"] = "REVISAO_HUMANA"
                row["finding"] = p.get("finding", "")
                if not p.get("finding"):
                    errors.append(f"{slug}:{p['id']}: revisão humana sem descrição do achado")
                findings.append({"product": slug, "promise": p["id"], "kind": "promessa_sem_correspondencia_comprovada", "text": p["text"], "detail": p.get("finding", "")})
            elif ptype == "deliverable":
                row["status"] = "ENTREGUE"
            elif ptype == "component":
                row["status"] = "ENTREGUE_IDENTICO_AO_AVULSO"
            elif ptype == "price":
                row["status"] = "CONTA_CONFERE"
            elif ptype == "content":
                row["status"] = "TEMA_PRESENTE_ANCORA_AUTOMATICA"
            else:
                row["status"] = "BENEFICIO_TEMA_PRESENTE_NAO_GARANTIDO"
            rows.append(row)

        # Qualidade de arquivo: abre, sem erro, acessível.
        for path, e in entries.items():
            o = e.get("open", {})
            if not o.get("ok"):
                errors.append(f"{slug}: arquivo do zip não abre: {path} ({o.get('detail')})")
            if e.get("kind") == "pdf":
                if o.get("tagged") is not True:
                    defects.append((slug, path, "pdf_sem_marcacao", "PDF sem marcação de acessibilidade (tagged)."))
                if not o.get("title"):
                    defects.append((slug, path, "pdf_sem_titulo", "PDF sem título nos metadados (WCAG 2.4.2, técnica PDF18): o leitor de tela anuncia só o nome do arquivo."))
                elif o["title"].strip().upper() == "ZEVANORY":
                    findings.append({"product": slug, "file": path, "kind": "acessibilidade_titulo_generico", "detail": f"Título do PDF é só '{o['title']}', sem dizer qual material é (WCAG 2.4.2 pede título descritivo)."})
            if e.get("kind") in ("pdf", "docx"):
                lang = (o.get("lang") or "").strip()
                if not lang.lower().startswith("pt"):
                    defects.append((slug, path, "idioma_declarado_incorreto", f"Idioma declarado '{lang or 'ausente'}' em material escrito em português (WCAG 3.1.1, nível A): o leitor de tela lê o texto com regras de pronúncia de outro idioma."))
            if e.get("kind") == "xlsx":
                rc = o.get("recalc")
                if not isinstance(rc, dict) or rc.get("status") not in ("PASS", "FAIL"):
                    errors.append(f"{slug}: planilha sem recálculo registrado no manifesto: {path}")
                elif rc.get("errors", 0) > 0:
                    errors.append(f"{slug}: planilha com {rc['errors']} erro(s) de fórmula no recálculo: {path}")
            for hit in e.get("quality_hits", []):
                findings.append({"product": slug, "file": path, "kind": "texto_a_revisar", "detail": hit})

        prod_defects = []
        for (dslug, dpath, dkind, ddetail) in defects[pdef_start:]:
            if (dslug, dpath, dkind) in registered:
                prod_defects.append({"file": dpath, "kind": dkind, "detail": ddetail, "status": "PI_VIOLADO_REGISTRADO"})
            else:
                errors.append(f"{slug}: DEFEITO PI NOVO ({dkind}) em {dpath}: {ddetail} Corrija o material ou registre em data/p24/open-defects.json com a ação do proprietário.")
        prod_errors = errors[perr_start:]
        report_products[slug] = {
            "sku": sku,
            "page": prod["page"],
            "artifact_name": mp.get("artifact_name"),
            "artifact_sha256": mp.get("artifact_sha256"),
            "catalog_sha256_match": bool(cat and mp.get("artifact_sha256") == cat["artifact_sha256"]),
            "files_in_zip": len(entries),
            "files_open_ok": sum(1 for e in entries.values() if e.get("open", {}).get("ok")),
            "promises_on_page": len(page_texts),
            "promises_mapped": sum(1 for t in page_texts if t in mapped),
            "promises": rows,
            "errors": prod_errors,
            "open_defects_pi": prod_defects,
            "findings": [f for f in findings if f.get("product") == slug],
        }

    for slug in man_products:
        if slug not in pmap.get("products", {}):
            errors.append(f"manifesto cita {slug}, que não está no mapa de promessas")
    for slug in price_by_slug:
        if slug not in pmap.get("products", {}):
            errors.append(f"{slug}: produto vendido sem mapa de promessas P24")

    observed = {(a, b, c) for (a, b, c, _d) in defects}
    for key in registered:
        if key not in observed:
            errors.append(f"open-defects: {key} não ocorre mais; remova o registro (o defeito foi corrigido ou o registro está errado)")

    blind = rubric.get("blind_evaluation", {})
    n_open = sum(len(p["open_defects_pi"]) for p in report_products.values())
    verdict = "FAIL" if (errors or n_open) else "NAO_COMPROVADO"
    return {
        "schema": SCHEMA_REPORT,
        "process": "P24",
        "evidence_label": "SINTÉTICA (conferência automática do material; nenhuma venda ou cliente real)",
        "generated_at": generated_at,
        "manifest_generated_at": manifest.get("generated_at"),
        "manifest_source": manifest.get("source"),
        "gate": "FAIL" if errors else "PASS",
        "p24_verdict": verdict,
        "verdict_reason": (
            "Falhas objetivas novas ou registro inconsistente." if errors else
            f"Gate objetivo verde (nenhuma regressão), mas o PI de acessibilidade está violado em {n_open} arquivo(s) registrado(s) em data/p24/open-defects.json; "
            "P24 = FAIL até o material ser corrigido (novo zip, novo SHA-256 no catálogo, decisão do proprietário)." if n_open else
            "Gate objetivo verde. P24 continua NÃO COMPROVADO: avaliação cega da rubrica (seção 6.1) "
            f"com status {blind.get('status', 'NOT_AVAILABLE')}, {sum(1 for f in findings if f['kind'] == 'promessa_sem_correspondencia_comprovada')} "
            "promessa(s) com revisão humana pendente, motivos de reembolso e avaliações reais NOT_AVAILABLE (sem vendas)."
        ),
        "refund_reasons": "NOT_AVAILABLE (vendas fechadas; nenhum pedido real)",
        "real_reviews": "NOT_AVAILABLE (nenhuma avaliação real registrada)",
        "blind_evaluation": blind.get("status", "NOT_AVAILABLE"),
        "totals": {
            "products": len(report_products),
            "promises_on_pages": sum(p["promises_on_page"] for p in report_products.values()),
            "promises_without_declared_delivery": sum(p["promises_on_page"] - p["promises_mapped"] for p in report_products.values()),
            "promises_pending_human_review": sum(1 for f in findings if f["kind"] == "promessa_sem_correspondencia_comprovada"),
            "files_checked": sum(p["files_in_zip"] for p in report_products.values()),
            "files_open_ok": sum(p["files_open_ok"] for p in report_products.values()),
            "errors": len(errors),
            "open_defects_pi": n_open,
            "findings": len(findings),
        },
        "errors": errors,
        "products": report_products,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=".")
    ap.add_argument("--report", help="grava o relatório JSON neste caminho")
    ap.add_argument("--generated-at", default=None)
    args = ap.parse_args(argv)
    root = Path(args.root)
    try:
        rep = evaluate(root, args.generated_at)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"P24_GATE=FAIL entrada inválida: {exc}")
        return 1
    if args.report:
        Path(args.report).write_text(json.dumps(rep, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for e in rep["errors"]:
        print(f"::error title=P24::{e}")
    for slug, p in rep["products"].items():
        print(f"P24 {slug}: promessas {p['promises_mapped']}/{p['promises_on_page']} mapeadas; arquivos {p['files_open_ok']}/{p['files_in_zip']} abrem; "
              f"sha catálogo={'ok' if p['catalog_sha256_match'] else 'DIVERGE'}; erros {len(p['errors'])}; defeitos PI registrados {len(p['open_defects_pi'])}; achados {len(p['findings'])}")
    t = rep["totals"]
    print(f"P24_TOTALS products={t['products']} promises={t['promises_on_pages']} without_delivery={t['promises_without_declared_delivery']} "
          f"pending_review={t['promises_pending_human_review']} files={t['files_open_ok']}/{t['files_checked']} errors={t['errors']} open_defects_pi={t['open_defects_pi']} findings={t['findings']}")
    print(f"P24_GATE={rep['gate']} P24_VERDICT={rep['p24_verdict']}")
    return 0 if rep["gate"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
