# ZEVANORY 10P Excellence Gate

Este diretório contém manifestos de certificação por item.

## Estados

- `UNSUBMITTED`: não submetido à certificação.
- `BLOCKED`: submetido, mas ainda sem prova integral.
- `APPROVED`: permitido somente quando os 10 pilares estão individualmente `PROVEN`.

Não existe aprovação por média, compensação ou maioria.

## Requisitos de cada pilar aprovado

Cada pilar deve conter:

- `result: "PROVEN"`
- `confidence >= 0.99`
- `excellence: 1.0`
- uma ou mais evidências reproduzíveis;
- referência de arquivo;
- SHA-256 do arquivo;
- timestamp ISO-8601;
- comando/instrução de reprodução.

O gate recusa qualquer `APPROVED` que não cumpra integralmente a política.
