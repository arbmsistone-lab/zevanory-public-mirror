import { readFileSync, existsSync } from 'node:fs';
const gateFile=process.argv[2];
if(!gateFile||!existsSync(gateFile)) {
  console.error('EVIDENCE_GATE_MISSING');
  process.exit(1);
}
const content=readFileSync(gateFile,'utf8');
const evidenceCount=(content.match(/^## Evidencia [123]/gm)||[]).length;
const sourceCount=(content.match(/^Fonte:\s*\S+/gm)||[]).length;
const classCount=(content.match(/^Classe:\s*[ABC](?:\/B)?/gm)||[]).length;
const approved=/^Veredito:\s*APROVADO\s*$/m.test(content);
if(evidenceCount<3||sourceCount<3||classCount<3||!approved) {
  console.error('EVIDENCE_GATE_BLOCKED');
  process.exit(2);
}
console.log('EVIDENCE_GATE_APPROVED');
process.exit(0);