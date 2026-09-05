import { channelReadiness } from './channelAdapters.mjs';
import { CHANNEL_PROFILES } from './channelProfiles.mjs';
import { assistedFallbackReadiness } from './assistedChannelFallbacks.mjs';

export function publicChannelStatus(env = process.env) {
  const readiness = channelReadiness(env);
  return Object.freeze(Object.fromEntries(Object.entries(readiness).map(([name, state]) => {
    const profile = CHANNEL_PROFILES[name];
    const fallback = assistedFallbackReadiness(name, env);
    const operationalReady = state.configured || fallback.ready;
    return [name, Object.freeze({
      provider: state.provider,
      configured: operationalReady,
      api_configured: state.configured,
      operational_ready: operationalReady,
      operational_mode: state.configured ? 'provider_api' : fallback.ready ? fallback.mode : 'blocked',
      implemented: state.implemented,
      commercial: state.commercial,
      role: state.role,
      profile_url: profile?.profileUrl || fallback.target_url || null,
    })];
  })));
}
