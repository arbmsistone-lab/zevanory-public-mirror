import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('../experiments/EXP-0001-G3-G4-BASELINE.md',import.meta.url),'utf8');

test('G3/G4 baseline is pre-registered but not approved',()=>{
  assert.match(source,/Status: PRE-REGISTRADO \/ NAO APROVADO/);
  assert.match(source,/Gate atual do projeto: G2/);
  assert.match(source,/payment_confirmed \/ sessoes com lead_qualified/);
  assert.match(source,/Wilson 95%/);
  assert.match(source,/14 dias consecutivos/);
  assert.match(source,/meia-largura do IC95% for <= 0,15/);
  assert.match(source,/28 dias/);
  assert.match(source,/Pagamento sem order_id\/session_id reconciliado.*BLOQUEIA G3/s);
  assert.match(source,/IA autonoma permanece proibida/);
  assert.match(source,/G3\/G4 so podem ser aprovados depois da coleta real e auditoria 3X/);
});