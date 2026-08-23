export const PRE_SALE_APPROVAL = Object.freeze({
  approved: false,
  blockers: Object.freeze([
    'custom_domain_unverified',
    'asaas_sandbox_unconfigured',
  ]),
  evidence: Object.freeze({
    global_sales_gate: 'EG-0018',
    payment_provider: 'EG-0013',
    checkout_order: 'EG-0014',
    financial_state: 'EG-0017',
  }),
});

export function preSaleApproval(){
  return PRE_SALE_APPROVAL;
}
