import {execFileSync} from 'node:child_process'; import {mkdirSync,writeFileSync} from 'node:fs'; import {dirname} from 'node:path'; import {buildCiAttestation} from './remote-attestation.mjs';
const startedAt=new Date().toISOString(); const gates=['test','audit:3x','audit:security:10x']; const results=[];
for(const gate of gates){try{execFileSync('npm',['run',gate],{stdio:'inherit'});results.push({name:gate,status:'passed'});}catch{results.push({name:gate,status:'failed'});break;}}
const completedAt=new Date().toISOString(); const attestation=buildCiAttestation(process.env,{startedAt,completedAt,gateResults:results});
const output=process.env.REMOTE_ATTESTATION_OUTPUT||'remote-attestation/attestation.json'; mkdirSync(dirname(output),{recursive:true}); writeFileSync(output,JSON.stringify(attestation,null,2)+'\n'); console.log(`REMOTE_ATTESTATION_PASS sha=${attestation.commit_sha} artifact_hash=${attestation.artifact_hash}`);
