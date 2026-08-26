export const PRE_SALE_APPROVAL = Object.freeze({
  approved: false,
  blockers: Object.freeze([]),
  evidence: Object.freeze({
    global_sales_gate: 'EG-0018',
    payment_provider: 'EG-0013',
    checkout_order: 'EG-0014',
    financial_state: 'EG-0017',
    custom_domain: 'EG-0021',
    asaas_sandbox_e2e: 'EG-0026',
  }),
});

export function preSaleApproval(){
  return PRE_SALE_APPROVAL;
}
