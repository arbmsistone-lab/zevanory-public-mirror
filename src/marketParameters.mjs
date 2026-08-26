export const MARKET_PARAMETERS = Object.freeze({
  lead_response: Object.freeze({
    benchmark_max_minutes: 60,
    operating_target_minutes: 5,
    source: 'HubSpot 2025, citing Harvard Business Review speed-to-lead research',
    source_url: 'https://blog.hubspot.com/sales/how-to-send-a-follow-up-email-after-no-response',
  }),
  prospecting: Object.freeze({
    benchmark_touchpoints: 8,
    internal_max_touchpoints: 8,
    source: 'HubSpot Prospecting Guide, updated 2025',
    source_url: 'https://blog.hubspot.com/sales/the-ultimate-guide-to-prospecting-how-many-touchpoints-when-and-what-type',
  }),
  warm_follow_up: Object.freeze({
    first_follow_up_min_hours: 48,
    first_follow_up_max_hours: 72,
    post_demo_max_hours: 48,
    source: 'HubSpot follow-up guidance, updated 2025',
    source_url: 'https://blog.hubspot.com/sales/how-to-send-a-follow-up-email-after-no-response',
  }),
  checkout: Object.freeze({
    cart_abandonment_market_percent: 70.22,
    source: 'Baymard Institute cart abandonment benchmark, updated 2025',
    source_url: 'https://baymard.com/lists/cart-abandonment-rate',
  }),
  web_vitals: Object.freeze({
    lcp_ms: 2500,
    inp_ms: 200,
    cls: 0.1,
    percentile: 75,
    source: 'Google web.dev Core Web Vitals',
    source_url: 'https://web.dev/articles/vitals',
  }),
  economics: Object.freeze({
    require_positive_contribution_margin: true,
    require_real_baseline_before_conversion_target: true,
    rationale: 'Conversion and CAC targets must be calibrated from the actual offer/channel baseline; no invented performance target.',
  }),
});
