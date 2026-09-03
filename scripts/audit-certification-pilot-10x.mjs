import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { certificationPilotPolicy } from '../src/certificationPilot.mjs';
import { REQUIRED_TABLES, REQUIRED_MIGRATIONS } from '../src/schemaHealth.mjs';

const read=(p)=>fs.readFileSync(p,'utf8');
const checks=[];
const check=(name,pass)=>checks.push({name,pass:Boolean(pass)});
const pilot=read('src/certificationPilot.mjs');
const asaas=read('src/http/checkoutAsaas.mjs');
const mp=read('src/http/checkoutMercadoPago.mjs');
const operator=read('api/events-operator.mjs');
const migration=read('db/migrations/016_certification_pilot.sql');

check('pilot is disabled and fail closed by default',certificationPilotPolicy({}).ready===false&&/CERTIFICATION_PILOT_ENABLED=false/.test(read('.env.example')));
check('pilot requires public global sales to stay locked',/global_sales_must_remain_closed_during_certification_pilot/.test(pilot)&&/SALE_GLOBALLY_ENABLED/.test(pilot));
check('pilot requires complete real activation inputs',/evaluateActivationReadiness/.test(pilot)&&/activation\.ready/.test(pilot));
check('pilot is capped to at most twenty real orders',/boundedInt\(env\.CERTIFICATION_PILOT_MAX_ORDERS,10,1,20\)/.test(pilot));
check('invite secrets are stored as sha256 only',/token_sha256/.test(migration)&&/hashCertificationPilotToken/.test(pilot)&&!/token text/i.test(migration));check('invite is bound to one session request and expiration',/bound_session_id/.test(migration)&&/request_id uuid UNIQUE/.test(migration)&&/expires_at/.test(migration)&&/expires_at>now\(\)/.test(pilot));
check('both checkout providers preserve normal global block and require invite token', [asaas,mp].every(s=>/sales_globally_blocked/.test(s)&&/x-certification-pilot-token/.test(s)&&/authorizeCertificationPilotCheckout/.test(s)));
check('pilot checkout evidence requires persisted checkout-ready provider truth',/o\.status='checkout_ready'/.test(pilot)&&/source_class:'canonical_database'/.test(pilot)&&/dimension:'checkout'/.test(pilot));
check('schema includes pilot migration with public-safe defaults',REQUIRED_TABLES.length===23&&REQUIRED_TABLES.includes('certification_pilot_invites')&&REQUIRED_MIGRATIONS.length===16&&REQUIRED_MIGRATIONS.includes('016_certification_pilot')&&/certification_pilot boolean NOT NULL DEFAULT false/.test(migration));
const quality=read('.github/workflows/quality.yml'),control=read('.github/workflows/quality-control-plane.yml');
const focused=spawnSync(process.execPath,['--test','test/certification-pilot.test.mjs','test/piloto.test.mjs'],{encoding:'utf8'});
check('operator path is authenticated non-unlocking and quality planes enforce pilot audit',/safeBearerEqual/.test(operator)&&/CERTIFICATION_PILOT_APPROVER/.test(operator)&&/commercial_unlock:false/.test(operator)&&quality.includes('audit:pilot:10x')&&control.includes('audit:pilot:10x')&&focused.status===0);

for(const [i,item] of checks.entries()) console.log(`${item.pass?'APPROVED':'FAILED'} ${String(i+1).padStart(2,'0')} ${item.name}`);
const failed=checks.filter(x=>!x.pass);
if(checks.length!==10||failed.length) process.exitCode=1;
else console.log(`AUDIT_CERTIFICATION_PILOT_10X_APPROVED units=${checks.length} approved=${checks.length} failed=0`);
