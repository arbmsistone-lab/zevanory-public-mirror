# EG-0032 — Sales Machine Final

Status: candidata a fechamento estrutural final.
Release: `ZEVANORY-EG0032-FINAL`.
Escopo: prontidão técnica de máquina de vendas; não autoriza vendas reais.

## Componentes obrigatórios
- CRM/pipeline persistente: `sales_leads`.
- Fila de ações/follow-up: `sales_actions`.
- Unit economics: `unit_economics_snapshots`.
- Learning engine dependente de evidência real.
- Telemetria → oferta → checkout → pagamento → refund já existentes.
- Parâmetros versionados em `specs/MARKET_PARAMETERS.md`.

## Critérios de fechamento
- suíte integral verde;
- Sales Machine 20X verde;
- resiliência concorrente verde;
- Security/Observability/DR/3X/30X verdes;
- schema 006 aplicado e `ready=true`;
- CI GitHub codificado;
- produção corresponde ao commit auditado;
- cinco kill-switches permanecem `false`.

## Regra de verdade
Benchmark externo é referência, não promessa. Conversão, CAC e ROAS só recebem meta após baseline real. A declaração final pode provar prontidão técnica para vender; não pode inventar vendas ou rentabilidade não observadas.