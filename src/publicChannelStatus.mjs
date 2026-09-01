import { channelReadiness } from './channelAdapters.mjs';
import { CHANNEL_PROFILES } from './channelProfiles.mjs';

export function publicChannelStatus(env = process.env) {
  const readiness = channelReadiness(env);
  return Object.freeze(Object.fromEntries(Object.entries(readiness).map(([name, state]) => {
    const profile = CHANNEL_PROFILES[name];
    return [name, Object.freeze({
      provider: state.provider,
      configured: state.configured,
      implemented: state.implemented,
      commercial: state.commercial,
      role: state.role,
      profile_url: profile?.profileUrl || null,
    })];
  })));
}
