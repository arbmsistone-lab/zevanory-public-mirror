import { neon } from '@neondatabase/serverless';
import {
  recoveryDiagnosticReady,
  listAsaasPaymentsByExternalReference,
  summarizeUncertainRecovery,
} from '../src/recovery.mjs';

const env=process.env.ASAAS_ENV;
const apiKey=process.env.ASAAS_API_KEY;
const databaseUrl=process.env.DATABASE_URL;

if(!recoveryDiagnosticReady({env,apiKey,databaseUrl})) {
  console.error('RECOVERY_DIAGNOSTIC_BLOCKED');
  process.exitCode=2;
} else {
  const sql=neon(databaseUrl);
  const orders=await sql.query(`
    SELECT order_id,external_reference,status,updated_at
    FROM orders
    WHERE status='checkout_uncertain'
    ORDER BY updated_at ASC
    LIMIT 25
  `);
  const diagnostics=[];
  for(const order of orders) {
    try {
      const payments=await listAsaasPaymentsByExternalReference(order.external_reference,apiKey);
      diagnostics.push(summarizeUncertainRecovery(order,payments));
    } catch(error) {
      diagnostics.push({
        order_id:String(order.order_id||'')||null,
        result:'provider_lookup_failed',
        error:String(error?.message||'unknown_error'),
      });
    }
  }
  console.log(JSON.stringify({
    mode:'read-only',
    environment:'sandbox',
    uncertain_orders:orders.length,
    diagnostics,
  },null,2));
}
