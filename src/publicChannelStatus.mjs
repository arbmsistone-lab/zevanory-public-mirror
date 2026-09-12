import { ACTIVE_COMMERCIAL_FRONTS } from './activeCommercialScope.mjs';
import { CHANNELS, channelReadiness } from './channelAdapters.mjs';
import { CHANNEL_PROFILES } from './channelProfiles.mjs';
import { assistedFallbackReadiness } from './assistedChannelFallbacks.mjs';
import { alternateAutomationReadiness } from './alternateChannelAutomation.mjs';
import { runtimeReleaseModes } from './release.mjs';

export function publicChannelStatus(env = process.env) {
  const all = channelReadiness(env);
  const readiness = Object.fromEntries(ACTIVE_COMMERCIAL_FRONTS.map(name=>[name,all[name]]));
  return Object.freeze(Object.fromEntries(Object.entries(readiness).map(([name, state]) => {
    const profile = CHANNEL_PROFILES[name];
    const fallback = assistedFallbackReadiness(name, env);
    const alternate = alternateAutomationReadiness(name, env);
    const operationalReady = state.configured || alternate.ready || fallback.ready;
    return [name, Object.freeze({
      provider: state.provider,
      configured: operationalReady,
      api_configured: state.configured,
      alternate_api_configured: alternate.ready,
      contingency_ready: false,
      contingency_mode: null,
      contingency_provider: null,
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
export function publicChannelReadinessSummary(env = process.env) {
  const state = publicChannelStatus(env);
  return Object.freeze(Object.fromEntries(Object.entries(state).map(([name, item]) => [name, Object.freeze({
    configured: Boolean(item.configured),
    api_configured: Boolean(item.api_configured),
    alternate_api_configured: Boolean(item.alternate_api_configured),
    contingency_ready: false,
    operational_ready: Boolean(item.operational_ready),
    operational_mode: item.operational_mode,
    commercial: Boolean(item.commercial),
  })])));
}

export function publicCommercialChannelReadinessSummary(env = process.env) {
  const salesMode = runtimeReleaseModes(env).salesMode;
  const globallyEnabled = salesMode === 'enabled';
  return Object.freeze(Object.fromEntries(ACTIVE_COMMERCIAL_FRONTS.map((name)=>{
    const def=CHANNELS[name];
    return [name,Object.freeze({
      commercial: Boolean(def.commercial),
      commercial_execution: def.commercial ? (globallyEnabled ? 'enabled' : 'blocked') : 'not_applicable',
      release_gate: salesMode,
      role: def.role,
    })];
  })));
}
