import { evaluateActivationReadiness } from './activationReadiness.mjs';

export function preSaleApproval(env=process.env){
  const readiness=evaluateActivationReadiness(env);
  return Object.freeze({
    approved:readiness.ready,
    blockers:readiness.blockers,
    evidence:Object.freeze({
      global_sales_gate:'EG-0018',
      payment_provider:'EG-0013',
      checkout_order:'EG-0014',
      financial_state:'EG-0017',
      custom_domain:'EG-0021',
      provider_sandbox_e2e:'EG-0026',
      sales_machine:'EG-0032',
      precommerce_model:'EG-0033',
    }),
  });
}

export const PRE_SALE_APPROVAL=preSaleApproval(Object.freeze({}));