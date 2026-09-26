// -----------------------------------------------------------------------------
// AdGuard Home API responses (v0.107.79), shaped after a real instance with
// anonymized names, domains and addresses. Each export is a factory so a test
// can mutate its copy freely.
// -----------------------------------------------------------------------------

export const status = () => ({
  version: 'v0.107.79',
  language: 'fr',
  dns_addresses: ['127.0.0.1', '::1', '172.23.0.2'],
  dns_port: 53,
  http_port: 3000,
  protection_disabled_duration: 0,
  start_time: 1789568008781.6165,
  protection_enabled: true,
  dhcp_available: true,
  running: true,
});

// 168 hourly buckets (7-day retention), oldest first: the last one is the
// current, partial hour. Queries: 700 per hour; blocked: 70 per hour, except
// the last 24 buckets, which follow a recognizable ramp (see below).
export const HOURLY_BUCKETS = 168;

export const stats = () => {
  const dns_queries = Array.from({ length: HOURLY_BUCKETS }, () => 700);
  const blocked_filtering = Array.from({ length: HOURLY_BUCKETS }, () => 70);
  // Last 24 hours: queries 100, 200, ..., 2400 (sum 30000), blocked 10% of it
  // (sum 3000), so the 24 h figures differ from the 7-day totals below.
  for (let i = 0; i < 24; i += 1) {
    dns_queries[HOURLY_BUCKETS - 24 + i] = (i + 1) * 100;
    blocked_filtering[HOURLY_BUCKETS - 24 + i] = (i + 1) * 10;
  }
  return {
    time_units: 'hours',
    num_dns_queries: 108293,
    num_blocked_filtering: 12336,
    num_replaced_safebrowsing: 0,
    num_replaced_safesearch: 0,
    num_replaced_parental: 0,
    avg_processing_time: 0.044136,
    dns_queries,
    blocked_filtering,
    replaced_safebrowsing: Array.from({ length: HOURLY_BUCKETS }, () => 0),
    replaced_parental: Array.from({ length: HOURLY_BUCKETS }, () => 0),
    top_queried_domains: [
      { 'api.example-cloud.com': 9120 },
      { 'time.example.org': 5211 },
      { 'cdn.example.net': 4020 },
    ],
    top_blocked_domains: [
      { 'app-analytics.example.com': 2589 },
      { 'telemetry.example.io': 1270 },
      { 'ads.example.net': 1168 },
    ],
    top_clients: [{ '192.168.1.175': 82974 }, { '192.168.1.119': 25319 }, { '192.168.1.200': 12 }],
    top_upstreams_responses: [{ '1.1.1.1:53': 47242 }, { '8.8.8.8:53': 28991 }],
    top_upstreams_avg_time: [{ '1.1.1.1:53': 0.017573 }, { '8.8.8.8:53': 0.029997 }],
  };
};

export const safeBrowsingStatus = () => ({ enabled: false });

export const parentalStatus = () => ({ enabled: false });

export const safeSearchStatus = () => ({
  enabled: false,
  bing: true,
  duckduckgo: true,
  ecosia: true,
  google: true,
  pixabay: true,
  yandex: true,
  youtube: true,
});

export const blockedServices = () => ({ schedule: { time_zone: 'UTC' }, ids: [] });

const persistentClient = (name, ip) => ({
  name,
  ids: [ip],
  use_global_settings: true,
  filtering_enabled: false,
  parental_enabled: false,
  safebrowsing_enabled: false,
  safesearch_enabled: false,
  safe_search: {
    enabled: false,
    bing: true,
    duckduckgo: true,
    ecosia: true,
    google: true,
    pixabay: true,
    yandex: true,
    youtube: true,
  },
  use_global_blocked_services: true,
  blocked_services_schedule: { time_zone: 'UTC' },
  blocked_services: [],
  upstreams: [],
  upstreams_cache_enabled: false,
  upstreams_cache_size: 0,
  tags: [],
  ignore_querylog: false,
  ignore_statistics: false,
});

export const clients = () => ({
  clients: [
    persistentClient('Home server', '192.168.1.119'),
    persistentClient('Kids tablet', '192.168.1.54'),
    persistentClient('Phone', '192.168.1.175'),
  ],
  auto_clients: [
    { whois_info: {}, ip: '127.0.0.1', name: 'localhost', source: 'etc/hosts' },
    { whois_info: {}, ip: '192.168.1.200', name: 'printer.lan', source: 'rdns' },
  ],
  supported_tags: ['device_audio', 'device_camera', 'device_laptop'],
});
