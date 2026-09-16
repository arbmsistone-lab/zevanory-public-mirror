# ARBM ONE Comercial — by ZEVANORY

## Origem certificada
Este clone comercial parte exatamente do SHA `83ae02254ac0a8908bc8f301f52d456ed4f2d1a9` do ARBM ONE certificado.
O ARBM ONE operacional original não deve receber mudanças vindas deste repositório sem nova auditoria.

## Objetivo
Entregar o mesmo núcleo funcional em instâncias separadas para clientes, com domínio, backend, dados, usuários e identidade empresarial próprios.

## Isolamento obrigatório por cliente
- Projeto Supabase dedicado ou isolamento equivalente aprovado.
- Domínio próprio configurado por `VITE_PUBLIC_ORIGIN`.
- Usuários, permissões e dados separados.
- Segredos nunca reutilizados entre clientes.
- Storage e funções vinculados ao backend da instância.
- Backup, restore e auditoria validados antes de produção.

## Branding
O produto permanece ARBM ONE. O nome da empresa cliente vem de `instancia_publica_v1`.
A distribuição comercial é feita pela ZEVANORY sem transformar a operação interna do proprietário em template público.

## Gate comercial
Criar clone, demo e documentação não autoriza vendas.
Preço, licença, suporte, SLA, provisionamento e release público devem ser aprovados antes de `ARBM_ONE_COMMERCIAL_RELEASE_APPROVED=true`.
