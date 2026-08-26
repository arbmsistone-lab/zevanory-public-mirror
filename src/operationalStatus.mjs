import { PROJECT } from './config.mjs';
import { RELEASE } from './release.mjs';

const countOf = (rows, key, value) => Number(rows.find((row) => row[key] === value)?.count || 0);

export function buildOperationalStatus({ telemetry = [], orders = [], financial = [], leads = [], actions = [], economics = [], lastEventAt = null } = {}) {
  const pageViews = countOf(telemetry, 'event_name', 'page_view');
  const qualified = countOf(telemetry, 'event_name', 'lead_qualified');
  const offers = countOf(telemetry, 'event_name', 'offer_sent');
  const checkouts = countOf(telemetry, 'event_name', 'checkout_started');
  const payments = countOf(financial, 'normalized_event', 'payment_confirmed');
  const refunds = countOf(financial, 'normalized_event', 'refund_confirmed');
  const orderTotal = orders.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const openLeadTotal = leads.filter((row)=>!['paid','delivered','refunded','unqualified','lost'].includes(row.stage)).reduce((sum,row)=>sum+Number(row.count||0),0);
  const scheduledActions = countOf(actions,'status','scheduled');
  const latestEconomics = economics[0] || null;

  return Object.freeze({
    project: PROJECT.name,
    gate: 'G2',
    experiment: Object.freeze({ id: PROJECT.experimentId, status: 'technical_ready_commercial_not_started' }),
    engine: Object.freeze({ technical_infrastructure: 'approved', commercial_autonomy: 'not_approved' }),
    sales_machine: Object.freeze({ structure_ready:true, crm:'ready', follow_up:'ready', unit_economics:'ready', learning:'ready', outbound_execution:'blocked' }),
    runtime: Object.freeze({ telemetry: 'active', checkout: RELEASE.checkoutMode, financial: RELEASE.financialMode }),
    metrics: Object.freeze({
      page_views: pageViews,
      leads_qualified: qualified,
      offers_sent: offers,
      checkouts_started: checkouts,
      orders: orderTotal,
      payments_confirmed: payments,
      refunds_confirmed: refunds,
      pipeline_open: openLeadTotal,
      actions_scheduled: scheduledActions,
    }),
    economics: latestEconomics ? Object.freeze({
      gross_revenue_brl:Number(latestEconomics.gross_revenue_brl||0),
      refunds_brl:Number(latestEconomics.refunds_brl||0),
      paid_orders:Number(latestEconomics.paid_orders||0),
    }) : null,
    last_event_at: lastEventAt,
  });
}
