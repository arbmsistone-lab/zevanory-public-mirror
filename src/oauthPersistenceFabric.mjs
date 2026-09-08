import { createHash } from 'node:crypto';
import { preserveStorageOperation, storageOperation } from './storageFabric.mjs';

const clean=(value,max=240)=>String(value??'').trim().slice(0,max);
const fingerprint=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);

export function oauthCredentialOperation({provider,subjectRef=null,token,identity=null,mode='production'}={}){
  const p=clean(provider,80);if(!p||!token||typeof token!=='object')throw new Error('oauth_credential_operation_invalid');
  const subject=subjectRef?clean(subjectRef,240):null;
  return storageOperation({
    operationId:`oauth-credential:${p}:${subject||'pending'}:${fingerprint(token)}`,
    operationType:'oauth.credential_reconciliation',
    subjectRef:subject,
    payload:{provider:p,mode:clean(mode,40),token,identity:identity??null,provider_token_obtained:true,connected:false,reconciliation_required:true},
  });
}

export async function preserveOAuthCredential(input,{env=process.env,fetchImpl=globalThis.fetch,requiredCopies=1}={}){
  const operation=oauthCredentialOperation(input);
  const journal=await preserveStorageOperation(operation,{env,fetchImpl,requiredCopies});
  return Object.freeze({preserved:journal.preserved,connected:false,reconciliation_required:true,operation_id:operation.operation_id,journal});
}

export const OAUTH_PERSISTENCE_RULES=Object.freeze({authorization_code_single_exchange:true,token_journal_encrypted:true,journal_never_claims_connected:true,persistence_failure_requires_reconciliation:true});
