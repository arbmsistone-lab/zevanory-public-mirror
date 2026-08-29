const terminalStages = new Set(['paid','delivered','refunded','unqualified','lost']);

const countRows = (rows, key, value) => Number(rows.find((row) => row[key] === value)?.count || 0);
const sumRows = (rows) => rows.reduce((sum, row) => sum + Number(row.count || 0), 0);

export function buildCommandCenter({ leads = [], actions = [], dueBuckets = [], riskBuckets = [] } = {}) {
  const stageCounts = Object.fromEntries(leads.map((row) => [String(row.stage), Number(row.count || 0)]));
  const openPipeline = leads.filter((row) => !terminalStages.has(String(row.stage))).reduce((sum,row)=>sum+Number(row.count||0),0);
  const scheduled = countRows(actions, 'status', 'scheduled');
  const completed = countRows(actions, 'status', 'completed');
  const blocked = countRows(actions, 'status', 'blocked');
  const overdue = countRows(dueBuckets, 'bucket', 'overdue');
  const due24h = countRows(dueBuckets, 'bucket', 'due_24h');
  const later = countRows(dueBuckets, 'bucket', 'later');
  const missingNext = countRows(riskBuckets, 'bucket', 'missing_next_action');
  const stale = countRows(riskBuckets, 'bucket', 'stale');
  const totalActions = sumRows(actions);
  const actionCompletionRate = totalActions > 0 ? completed / totalActions : null;
  const queuePressure = overdue + blocked + missingNext + stale;
  const observedFunnel = Object.freeze({
    new:Number(stageCounts.new||0), contacted:Number(stageCounts.contacted||0), qualified:Number(stageCounts.qualified||0),
    offer_sent:Number(stageCounts.offer_sent||0), checkout_started:Number(stageCounts.checkout_started||0), paid:Number(stageCounts.paid||0),
  });
  const priorities = Object.freeze([
    Object.freeze({ key:'overdue_actions', count:overdue, severity:overdue>0?'critical':'ok' }),
    Object.freeze({ key:'blocked_actions', count:blocked, severity:blocked>0?'warning':'ok' }),
    Object.freeze({ key:'missing_next_action', count:missingNext, severity:missingNext>0?'warning':'ok' }),
    Object.freeze({ key:'stale_open_leads', count:stale, severity:stale>0?'warning':'ok' }),
    Object.freeze({ key:'due_next_24h', count:due24h, severity:due24h>0?'attention':'ok' }),
  ]);
  return Object.freeze({
    pipeline:Object.freeze({ open:openPipeline, stages:Object.freeze(stageCounts), observed_funnel:observedFunnel }),
    work_queue:Object.freeze({ scheduled, completed, blocked, overdue, due_24h:due24h, later, pressure:queuePressure }),
    risk:Object.freeze({ missing_next_action:missingNext, stale_open_leads:stale }),
    execution:Object.freeze({
      action_completion_rate: actionCompletionRate,
      forecast_mode:'baseline_required',
      next_best_action_mode:'rules_based',
      predictive_forecast_available:false,
    }),
    priorities,
  });
}
