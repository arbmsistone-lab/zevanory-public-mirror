import { PROJECT } from './config.mjs';
import { RELEASE } from './release.mjs';

const countOf = (rows, key, value) => Number(rows.find((row) => row[key] === value)?.count || 0);

export function buildOperationalStatus({ telemetry = [], orders = [], financial = [], lastEventAt = null } = {}) {
  const pageViews = countOf(telemetry, 'event_name', 'page_view');
  const leads = countOf(telemetry, 'event_name', 'lead_qualified');
  const offers = countOf(telemetry, 'event_name', 'offer_sent');
  const checkouts = countOf(telemetry, 'event_name', 'checkout_started');
  const payments = countOf(financial, 'normalized_event', 'payment_confirmed');
  const refunds = countOf(financial, 'normalized_event', 'refund_confirmed');
  const orderTotal = orders.reduce((sum, row) => sum + Number(row.count || 0), 0);

  return Object.freeze({
    project: PROJECT.name,
    gate: 'G2',
    experiment: Object.freeze({ id: PROJECT.experimentId, status: 'technical_ready_commercial_not_started' }),
    engine: Object.freeze({ technical_infrastructure: 'approved', commercial_autonomy: 'not_approved' }),
    runtime: Object.freeze({ telemetry: 'active', checkout: RELEASE.checkoutMode, financial: RELEASE.financialMode }),
    metrics: Object.freeze({ page_views: pageViews, leads_qualified: leads, offers_sent: offers, checkouts_started: checkouts, orders: orderTotal, payments_confirmed: payments, refunds_confirmed: refunds }),
    last_event_at: lastEventAt,
  });
}
