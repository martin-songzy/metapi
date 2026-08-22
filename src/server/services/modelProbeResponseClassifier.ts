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

function findErrorKeyword(rawBody: string, errorKeywords: string[]): string | null {
  const normalizedBody = rawBody.toLowerCase();
  return errorKeywords.find((keyword) => keyword && normalizedBody.includes(keyword.toLowerCase())) ?? null;
}

export function classifySuccessfulProbeResponse(input: {
  endpoint: 'chat' | 'messages' | 'responses';
  rawBody: string;
  errorKeywords?: string[];
}): ModelProbeResponseClassification {
  let body: unknown;
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    const errorKeyword = findErrorKeyword(input.rawBody, input.errorKeywords ?? []);
    return errorKeyword
      ? unsupported(`probe response matched error keyword: ${errorKeyword}`)
      : inconclusive('invalid or non-JSON probe response');
  }

  if (!isJsonObject(body)) {
    const errorKeyword = findErrorKeyword(input.rawBody, input.errorKeywords ?? []);
    return errorKeyword
      ? unsupported(`probe response matched error keyword: ${errorKeyword}`)
      : inconclusive('invalid or non-JSON probe response');
  }

  // A top-level `error` settles ONE thing on its own: the reply is not an answer,
  // so it can never be `supported`. What it does NOT settle is whether the model
  // is absent, and that distinction decides whether persistent state is written.
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
  if (typeof body.error === 'string' || isJsonObject(body.error)) {
    const errorKeyword = findErrorKeyword(input.rawBody, input.errorKeywords ?? []);
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

  const errorKeyword = findErrorKeyword(input.rawBody, input.errorKeywords ?? []);
  if (errorKeyword) return unsupported(`probe response matched error keyword: ${errorKeyword}`);

  return protocolShaped
    ? inconclusive('probe response contains no usable content')
    : inconclusive('invalid or non-JSON probe response');
}
