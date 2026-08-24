import { describe, expect, it } from 'vitest';

import {
  MODEL_PROBE_PROXY_CREDENTIAL_MASK,
  maskProxyCredentialsInText,
} from './modelProbeSecrets.js';

/**
 * The site-credential mask is exercised through `modelProbeRunService.test.ts`.
 * These cases cover the PROXY credential, which no layer passes to that mask and
 * which leaked for real: a probe against a site configured with
 * `socks5://user:pass@host:port` failed with "Request cannot be constructed from a
 * URL that includes credentials: socks5://user:pass@host:port/v1/chat/completions",
 * and that message became the persisted probe `reason` shown on the results page.
 */
describe('maskProxyCredentialsInText', () => {
  it('masks the userinfo of the socks5 URL from the observed failure', () => {
    const masked = maskProxyCredentialsInText(
      'Request cannot be constructed from a URL that includes credentials: '
      + 'socks5://cc-proxy:Song501119@103.7.139.99:10080/v1/chat/completions',
    );

    // The secret must be gone in BOTH halves — user and password.
    expect(masked).not.toContain('Song501119');
    expect(masked).not.toContain('cc-proxy');
    // ...while the parts an operator needs in order to diagnose survive.
    expect(masked).toContain('socks5://');
    expect(masked).toContain('103.7.139.99:10080');
    expect(masked).toContain(MODEL_PROBE_PROXY_CREDENTIAL_MASK);
  });

  it.each([
    ['http://user:pw123456@proxy.example.com:8080', 'pw123456'],
    ['https://user:pw123456@proxy.example.com', 'pw123456'],
    ['socks5h://user:pw123456@10.0.0.1:1080', 'pw123456'],
    ['socks4://user:pw123456@10.0.0.1:1080', 'pw123456'],
  ])('masks credentials in %s', (url, secret) => {
    const masked = maskProxyCredentialsInText(`connect ECONNREFUSED via ${url}`);
    expect(masked).not.toContain(secret);
    expect(masked).toContain(MODEL_PROBE_PROXY_CREDENTIAL_MASK);
  });

  it('masks a userinfo that carries no password', () => {
    const masked = maskProxyCredentialsInText('socks5://loneuser@10.0.0.1:1080 failed');
    expect(masked).not.toContain('loneuser');
    expect(masked).toContain(MODEL_PROBE_PROXY_CREDENTIAL_MASK);
  });

  it('leaves text without embedded credentials untouched', () => {
    // Positive control: without this, a mask that replaced everything — or one
    // whose pattern matched far too much — would satisfy every assertion above.
    const clean = 'HTTP 404: no such model: gpt-5-turbo via https://relay.example.com/v1';
    expect(maskProxyCredentialsInText(clean)).toBe(clean);
  });

  it('does not treat a bare host:port or an email-like string as userinfo', () => {
    expect(maskProxyCredentialsInText('connect to 10.0.0.1:1080 failed')).toBe(
      'connect to 10.0.0.1:1080 failed',
    );
    // No scheme, so nothing to strip — masking here would corrupt the message.
    expect(maskProxyCredentialsInText('contact ops@example.com')).toBe('contact ops@example.com');
  });

  it.each([['', ''], [null, ''], [undefined, '']])(
    'returns empty string for %p rather than throwing',
    (input, expected) => {
      expect(maskProxyCredentialsInText(input as unknown as string)).toBe(expected);
    },
  );
});
