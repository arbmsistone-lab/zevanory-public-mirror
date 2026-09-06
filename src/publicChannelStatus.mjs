import { channelReadiness } from './channelAdapters.mjs';
import { CHANNEL_PROFILES } from './channelProfiles.mjs';
import { assistedFallbackReadiness } from './assistedChannelFallbacks.mjs';
import { alternateAutomationReadiness } from './alternateChannelAutomation.mjs';
import { nuvemshopCsvFallbackReadiness } from './nuvemshopCsvFallback.mjs';

export function publicChannelStatus(env = process.env) {
  const readiness = channelReadiness(env);
  return Object.freeze(Object.fromEntries(Object.entries(readiness).map(([name, state]) => {
    const profile = CHANNEL_PROFILES[name];
    const fallback = assistedFallbackReadiness(name, env);
    const alternate = alternateAutomationReadiness(name, env);
    const contingency = name==='nuvemshop' ? nuvemshopCsvFallbackReadiness(env) : {ready:false,mode:null,provider:null};
    const operationalReady = state.configured || alternate.ready || fallback.ready;
    return [name, Object.freeze({
      provider: state.provider,
      configured: operationalReady,
      api_configured: state.configured,
      alternate_api_configured: alternate.ready,
      contingency_ready: contingency.ready,
      contingency_mode: contingency.mode,
      contingency_provider: contingency.provider,
      active_provider: state.configured ? state.provider : alternate.ready ? alternate.provider : null,
      operational_ready: operationalReady,
      operational_mode: state.configured ? 'provider_api' : alternate.ready ? alternate.mode : fallback.ready ? fallback.mode : 'blocked',
      implemented: state.implemented,
      commercial: state.commercial,
      role: state.role,
      profile_url: profile?.profileUrl || fallback.target_url || null,
    })];
  })));
}
