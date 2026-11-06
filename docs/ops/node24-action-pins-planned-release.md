# Migração de Actions para Node 24 — aplicar com publicação planejada

Este lote não deve ser mesclado isoladamente. Ele altera workflows que casam filtros de `push` em `gh-pages`, inclusive
deploys e operações externas; deve acompanhar uma publicação previamente autorizada (por exemplo, Release 2).

## Versões e commits conferidos

| Action | Release | SHA fixado | Runtime |
|---|---|---|---|
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | Node 24 |
| `actions/setup-node` | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` | Node 24 |
| `actions/upload-artifact` | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | Node 24 |
| `actions/setup-python` | v7.1.0 | `6d4fd22b20465ccc0f7354476588e8df7c9ca0e0` | Node 24 |
| `actions/download-artifact` | v7.0.0 | `37930b1c2abaa49bbe596cd826c3c89aef350131` | Node 24 |
| `google-github-actions/auth` | v3.0.0 | `7c6bc770dae815cd3e89ee6cdf493a5fab2cc093` | Node 24 |
| `google-github-actions/setup-gcloud` | v3.0.1 | `aa5489c8933f4cc7a4f7d45035b3b1440c9c10db` | Node 24 |
| `actions/jekyll-build-pages` | v1.0.13 | `44a6e6beabd48582f863aeeb6cb2151cc1716697` | **sem versão Node 24**: é uma Action de contêiner; foi apenas fixada no release imutável atual |

Fontes oficiais: páginas de releases e `action.yml` dos próprios repositórios das Actions. A escolha de
`download-artifact@v7` evita as mudanças incompatíveis de extração/ESM introduzidas no v8 e ainda satisfaz Node 24.

## Arquivos fora de `.github/workflows`

As alterações em testes e mutantes apenas atualizam expectativas literais de runner/SHA ou incluem o novo contrato de
pins no manifesto. `scripts/sandbox_static_checks.py` atualiza o blob registrado de `zees16-control-reconciler.yml` e
agora contém uma justificativa datada e limitada a runner/pins, sem mudança de lógica, gatilho, Environment, permissões
ou KV. Nenhum arquivo de aplicação, site ou dado publicado é alterado.
