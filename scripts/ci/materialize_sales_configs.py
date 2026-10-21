#!/usr/bin/env python3
"""Gera as configs do site de vendas a partir de wrangler.sales.toml (fonte única para os jobs verify e deploy).

- wrangler.sales.deploy.toml: Worker canônico, SEM rotas e com workers_dev = false (menor privilégio;
  diagnóstico Sol 21/10, run 39601904471). O custom domain vendas.zevanory.api.br é gerido no painel.
- wrangler.sales.preview.toml: candidato isolado em workers.dev, sem rotas.
Entradas: GITHUB_SHA, GITHUB_RUN_ID. Executar na raiz do repositório.
"""
from pathlib import Path
import os
sha=os.environ["GITHUB_SHA"]
source=Path("wrangler.sales.toml").read_text(encoding="utf-8")
source=source.replace("SOURCE_SHA_REPLACED_AT_DEPLOY",sha)

def strip_routes(text):
    out=[];skipping=False
    for line in text.splitlines():
        if line.strip().startswith("routes = ["):
            skipping=True;continue
        if skipping:
            if line.strip()=="]":skipping=False
            continue
        out.append(line)
    return out

# Menor privilégio (diagnóstico Sol 21/10, run 39601904471): o custom domain vendas.zevanory.api.br já existe.
# Pela documentação Cloudflare (Workers > Authorization > Routes and Custom Domains), um deploy que não
# adiciona/altera/remove rota só precisa de Editor no Worker; sem a chave routes o wrangler não sincroniza
# rotas da zona. workers_dev = false mantém o domínio próprio como única entrada pública.
# A conferência pós-deploy (/health release == SHA no domínio canônico) prova que o domínio segue ligado.
deploy=[]
inserted=False
for line in strip_routes(source):
    if line.strip()=="[assets]" and not inserted:
        deploy.append("workers_dev = false");inserted=True
    deploy.append(line)
assert inserted and not any(l.strip().startswith("routes") for l in deploy), "deploy config must not manage routes"
Path("wrangler.sales.deploy.toml").write_text("\n".join(deploy)+"\n",encoding="utf-8")

candidate=f"zevanory-sales-candidate-{os.environ['GITHUB_RUN_ID']}"
lines=[]
skipping_routes=False
inserted_workers_dev=False
for line in source.splitlines():
    if line.startswith('name = "zevanory-sales-public"'):
        lines.append(f'name = "{candidate}"')
        continue
    if line.strip().startswith("routes = ["):
        skipping_routes=True
        continue
    if skipping_routes:
        if line.strip()=="]":
            skipping_routes=False
        continue
    if line.strip()=="[assets]" and not inserted_workers_dev:
        lines.append("workers_dev = true")
        inserted_workers_dev=True
    lines.append(line)
Path("wrangler.sales.preview.toml").write_text("\n".join(lines)+"\n",encoding="utf-8")
Path("/tmp/candidate-name").write_text(candidate,encoding="utf-8")
print("CANDIDATE="+candidate)
