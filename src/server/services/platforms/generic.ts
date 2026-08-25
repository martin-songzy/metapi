import { StandardApiProviderAdapterBase } from './standardApiProvider.js';

/**
 * A site whose management API this app knows nothing about.
 *
 * Every other adapter exists because it can speak some vendor's management
 * surface — login, check-in, balance, token minting. This one deliberately speaks
 * none of it. It exists so a relay that only offers an OpenAI-compatible
 * `/v1/models` + `/v1/chat/completions` pair can still be brought under
 * management: listed, given accounts, and swept by the active model probe.
 *
 * What it inherits from `StandardApiProviderAdapterBase`, and why that is the
 * right base rather than `BasePlatformAdapter`: login and check-in answer
 * "unsupported" instead of throwing, `getUserInfo` answers null, and `getBalance`
 * answers zeros. That last one matters more than it looks — `balanceService`
 * treats a THROWN balance error as evidence the account is broken
 * (`setAccountRuntimeHealth({state:'unhealthy'})`, plus a possible
 * token-expired alert). A generic site can never report balance, which is a
 * permanent property of the platform, not a fault of the account. Returning zeros
 * keeps such an account healthy; the UI is where "no balance data" is presented as
 * 未知.
 *
 * Two properties are load-bearing and both are asserted:
 *
 * - `detect()` ALWAYS returns false. This adapter must never win auto-detection:
 *   its `getModels` would succeed against nearly any OpenAI-compatible relay,
 *   including every New API / One API fork, and claiming those would cost them
 *   their real adapter's check-in and balance support. It is reachable only by an
 *   explicit operator choice.
 * - `getModels()` NEVER throws. It returns `[]` when the endpoint is missing,
 *   refuses the key, or answers something unparseable. That is what lets a
 *   connection be created against a site that cannot be verified — the caller
 *   decides whether an empty list is fatal, and for a generic site it is not.
 */
export class GenericAdapter extends StandardApiProviderAdapterBase {
  readonly platformName = 'generic';

  /**
   * Never auto-detected. See the class docblock: a generic site is an explicit
   * operator decision, because this adapter would otherwise shadow every
   * OpenAI-compatible fork that has a real adapter.
   */
  async detect(_url: string): Promise<boolean> {
    return false;
  }

  /**
   * Best-effort `GET /v1/models` as the supplied credential.
   *
   * `fetchModelsFromStandardEndpoint` already swallows transport and non-2xx
   * failures into `[]`, but it deliberately THROWS on a payload it cannot map, so
   * a mapper bug in a real provider adapter stays visible. A generic site has no
   * agreed payload shape to get wrong, and an unparseable body here is a fact
   * about the upstream rather than a bug in this file — so it is caught and
   * reported as "no models", keeping the never-throws contract whole.
   */
  async getModels(baseUrl: string, token: string): Promise<string[]> {
    try {
      return await this.fetchModelsFromStandardEndpoint({
        baseUrl,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      return [];
    }
  }
}
