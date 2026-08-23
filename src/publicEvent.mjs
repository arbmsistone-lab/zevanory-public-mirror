import { PUBLIC_EVENTS, sanitizeText } from './telemetry.mjs';
import { PROJECT, isUuid } from './config.mjs';

export function normalizePublicEvent(body) {
  if (!body || typeof body !== 'object') return null;
  if (!PUBLIC_EVENTS.has(body.name)) return null;
  if (!isUuid(body.event_id) || !isUuid(body.session_id)) return null;
  const channel = sanitizeText(body.channel, 40);
  if (!channel) return null;
  return Object.freeze({
    event_id: String(body.event_id).toLowerCase(),
    event_name: body.name,
    session_id: String(body.session_id).toLowerCase(),
    experiment_id: PROJECT.experimentId,
    offer_id: PROJECT.offerId,
    channel,
    source: 'web'
  });
}
