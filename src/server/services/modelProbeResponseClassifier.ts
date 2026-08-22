export type ModelProbeFailureKind =
  | 'model_missing' | 'error_body' | 'empty_content'
  | 'timeout' | 'network' | 'auth' | 'rate_limit' | 'upstream';

export type ModelProbeResponseClassification = {
  status: 'supported' | 'unsupported' | 'inconclusive';
  failureKind: ModelProbeFailureKind | null;
  reason: string;
};

type JsonObject = Record<string, unknown>;

function capReason(reason: string): string {
  return reason.slice(0, 1_000);
}

function unsupported(reason: string): ModelProbeResponseClassification {
  return {
    status: 'unsupported',
    failureKind: 'error_body',
    reason: capReason(reason),
  };
}

/**
 * `failureKind` is a parameter because the two ways a probe can be inconclusive
 * are genuinely different diagnoses: nothing usable came back
 * (`empty_content`), or an error came back that no configured keyword
 * recognized (`error_body`). Collapsing both into `empty_content` would tell an
 * operator reading the results table that an out-of-balance relay returned an
 * empty answer.
 */
function inconclusive(
  reason: string,
  failureKind: ModelProbeFailureKind = 'empty_content',
): ModelProbeResponseClassification {
  return {
    status: 'inconclusive',
    failureKind,
    reason: capReason(reason),
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textFromChatContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  return value
    .filter(isJsonObject)
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .join('');
}

function textFromTypedBlocks(value: unknown, types: string[]): string {
  if (!Array.isArray(value)) return '';

  return value
    .filter(isJsonObject)
    .map((item) => types.includes(item.type as string) && typeof item.text === 'string' ? item.text : '')
    .join('');
}

function extractChatContent(body: JsonObject): string {
  if (!Array.isArray(body.choices)) return '';

  return body.choices
    .filter(isJsonObject)
    .map((choice) => isJsonObject(choice.message) ? textFromChatContent(choice.message.content) : '')
    .join('');
}

function extractMessagesContent(body: JsonObject): string {
  return textFromTypedBlocks(body.content, ['text']);
}

function extractResponsesContent(body: JsonObject): string {
  const topLevelText = typeof body.output_text === 'string' ? body.output_text : '';
  if (!Array.isArray(body.output)) return topLevelText;

  return topLevelText + body.output
    .filter(isJsonObject)
    .map((output) => textFromTypedBlocks(output.content, ['output_text', 'text']))
    .join('');
}

function isProtocolShapedResponse(endpoint: 'chat' | 'messages' | 'responses', body: JsonObject): boolean {
  return endpoint === 'chat'
    ? Array.isArray(body.choices)
    : endpoint === 'messages'
      ? Array.isArray(body.content)
      : typeof body.output_text === 'string' || Array.isArray(body.output);
}

/**
 * Text a keyword may be matched against, with JSON's `\uXXXX` escapes already
 * resolved.
 *
 * `JSON.parse` does the decoding; re-serializing puts the characters back
 * literally, because `JSON.stringify` escapes only control characters, quotes,
 * backslashes and lone surrogates — never non-ASCII. So this is what makes
 * `"模型不存在"` and `"模型不存在"` match the same keyword.
 * Searching `rawBody` alone did not: the escaped form matched nothing, and five of
 * the eight shipped default keywords are CJK while `ensure_ascii=True` is Python's
 * default and relays are commonly Python.
 */
function searchableText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Circular or non-serializable cannot come out of `JSON.parse`, so this is
    // unreachable for real input and exists only so a keyword search can never
    // throw where a verdict is expected.
    return '';
  }
}

/**
 * Searches every candidate text, so a caller can supply both a decoded form and
 * the raw wire text without either shadowing the other.
 */
function findErrorKeyword(haystacks: readonly string[], errorKeywords: string[]): string | null {
  const normalized = haystacks
    .filter((text) => text.length > 0)
    .map((text) => text.toLowerCase());

  return errorKeywords.find((keyword) => {
    if (!keyword) return false;
    const needle = keyword.toLowerCase();
    return normalized.some((text) => text.includes(needle));
  }) ?? null;
}

/**
 * The error a body announces at top level, or `undefined` for "no error".
 *
 * Exists because the guard used to be `typeof body.error === 'string' ||
 * isJsonObject(body.error)`, and `isJsonObject` excludes arrays — so an
 * array-valued, boolean or numeric `error`, or a body using `errors`, fell past
 * the branch entirely and could read `supported` off its content. That is the
 * false-positive class this feature exists to remove, and the docblock claiming
 * "an error body can never be `supported`" was true of only two of the shapes.
 *
 * Excludes the conventional "no error" sentinels — `null`, `false`, `0`, `[]` and
 * an absent key. Relays and SDK wrappers really do emit `{"error": null, …}` or
 * `{"error": false, …}` alongside a good answer, so reading those as errors would
 * turn working models into `inconclusive` and lose the verdict the feature exists
 * to produce.
 *
 * An empty string and an empty object DO count, unchanged from before: that was
 * already the behaviour for `error`, narrowing it would newly let a body reach
 * `supported`, and this function must not relax anything.
 */
function announcedError(body: JsonObject): unknown {
  for (const key of ['error', 'errors'] as const) {
    const value = body[key];
    if (typeof value === 'string' || isJsonObject(value)) return value;
    if (Array.isArray(value)) {
      if (value.length > 0) return value;
      continue;
    }
    if (value === true) return value;
    if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return value;
  }
  return undefined;
}

export function classifySuccessfulProbeResponse(input: {
  endpoint: 'chat' | 'messages' | 'responses';
  rawBody: string;
  errorKeywords?: string[];
}): ModelProbeResponseClassification {
  const errorKeywords = input.errorKeywords ?? [];

  let body: unknown;
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    // Nothing parsed, so there is no decoded form and no structure to scope to.
    const errorKeyword = findErrorKeyword([input.rawBody], errorKeywords);
    return errorKeyword
      ? unsupported(`probe response matched error keyword: ${errorKeyword}`)
      : inconclusive('invalid or non-JSON probe response');
  }

  if (!isJsonObject(body)) {
    // Both forms: the decoded value, plus the raw text so nothing that matched
    // before this stops matching.
    const errorKeyword = findErrorKeyword([searchableText(body), input.rawBody], errorKeywords);
    return errorKeyword
      ? unsupported(`probe response matched error keyword: ${errorKeyword}`)
      : inconclusive('invalid or non-JSON probe response');
  }

  // An announced top-level error settles ONE thing on its own: the reply is not an
  // answer, so it can never be `supported` — see `announcedError` for which shapes
  // count and which "no error" sentinels deliberately do not. What it does NOT
  // settle is whether the model is absent, and that distinction decides whether
  // persistent state is written.
  //
  // So the keyword list is consulted here, BEFORE the verdict, and an error no
  // keyword recognizes falls through to `inconclusive`. `{"error":{"message":
  // "余额不足"}}` at HTTP 200 is the commonest relay error shape there is; ruling it
  // `unsupported` marked every probed model at an out-of-balance or rate-limited
  // site unavailable — the mirror image of the false-positive class this feature
  // exists to remove. `unsupported` is also the only verdict that reaches
  // `site_disabled_models`, which is keyed by SITE rather than by account and
  // never auto-clears, so the fail-safe direction for an unrecognized error is
  // "unclear", not "gone".
  //
  // Model-absence wording still lands `unsupported` through the configured
  // keywords (`no such model`, `model_not_found`, `模型不存在`, `无可用渠道`, …),
  // and an operator who wants any other phrasing treated as absence adds it to
  // that list. See `modelProbeConfigService.DEFAULT_ERROR_KEYWORDS`.
  //
  // The keyword is searched in the ANNOUNCED ERROR ONLY, not across the whole
  // body. Whole-body search ran toward the destructive verdict: any occurrence
  // anywhere — a model name like `test-model_not_found-probe`, an echoed prompt,
  // a relay quoting the request back — promoted an account-level error to
  // `unsupported`. The scope is the error value in full, nested fields included,
  // so a two-layer relay error (`{"message":"余额不足","upstream_error":
  // "无可用渠道"}`) still matches on its inner half.
  //
  // COST, stated because it is a real narrowing: a model-absence keyword that
  // appears only OUTSIDE the error — `{"error":{…},"code":"model_not_found"}` at
  // top level — now reads `inconclusive`. That is lost detection, which is the
  // same fail-safe direction this branch already takes for an unrecognized error,
  // and the opposite direction from a wrong site-wide disable.
  const announced = announcedError(body);
  if (announced !== undefined) {
    const errorKeyword = findErrorKeyword([searchableText(announced)], errorKeywords);
    return errorKeyword
      ? unsupported(`probe response matched error keyword: ${errorKeyword}`)
      : inconclusive('probe response contains an unrecognized top-level error', 'error_body');
  }

  const protocolShaped = isProtocolShapedResponse(input.endpoint, body);
  const content = input.endpoint === 'chat'
    ? extractChatContent(body)
    : input.endpoint === 'messages'
      ? extractMessagesContent(body)
      : extractResponsesContent(body);

  if (content.trim()) {
    return {
      status: 'supported',
      failureKind: null,
      reason: 'probe response contains protocol-native content',
    };
  }

  // No announced error to scope to here, so the search stays whole-body — the
  // pre-existing behaviour, with a positive test. Both forms, so an escaped body
  // reaches the same verdict as a literal one.
  const errorKeyword = findErrorKeyword([searchableText(body), input.rawBody], errorKeywords);
  if (errorKeyword) return unsupported(`probe response matched error keyword: ${errorKeyword}`);

  return protocolShaped
    ? inconclusive('probe response contains no usable content')
    : inconclusive('invalid or non-JSON probe response');
}
