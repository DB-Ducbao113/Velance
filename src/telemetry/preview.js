// The visitor showroom does not load the collector, even with old consent.
// Internal diagnostics remain available only in an explicit loopback preview.
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (local && new URLSearchParams(location.search).get('diagnostics') === '1') {
  void import('./collector.js?v=12.0-settings');
}
