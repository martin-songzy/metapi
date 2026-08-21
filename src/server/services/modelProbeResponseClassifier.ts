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

function inconclusive(reason: string): ModelProbeResponseClassification {
  return {
    status: 'inconclusive',
    failureKind: 'empty_content',
    reason: capReason(reason),
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  return value
    .filter(isJsonObject)
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .join('');
}

function extractChatContent(body: JsonObject): string {
  if (!Array.isArray(body.choices)) return '';

  return body.choices
    .filter(isJsonObject)
    .map((choice) => isJsonObject(choice.message) ? textFromContent(choice.message.content) : '')
    .join('');
}

function extractMessagesContent(body: JsonObject): string {
  if (!Array.isArray(body.content)) return '';

  return body.content
    .filter(isJsonObject)
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .join('');
}

function extractResponsesContent(body: JsonObject): string {
  if (!Array.isArray(body.output)) return '';

  return body.output
    .filter(isJsonObject)
    .map((output) => textFromContent(output.content))
    .join('');
}

function findErrorKeyword(rawBody: string, errorKeywords: string[]): string | null {
  const normalizedBody = rawBody.toLocaleLowerCase();
  return errorKeywords.find((keyword) => keyword && normalizedBody.includes(keyword.toLocaleLowerCase())) ?? null;
}

export function classifySuccessfulProbeResponse(input: {
  endpoint: 'chat' | 'messages' | 'responses';
  rawBody: string;
  errorKeywords?: string[];
}): ModelProbeResponseClassification {
  const errorKeyword = findErrorKeyword(input.rawBody, input.errorKeywords ?? []);
  if (errorKeyword) return unsupported(`probe response matched error keyword: ${errorKeyword}`);

  let body: unknown;
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    return inconclusive('invalid or non-JSON probe response');
  }

  if (!isJsonObject(body)) {
    return inconclusive('invalid or non-JSON probe response');
  }

  if (typeof body.error === 'string' || isJsonObject(body.error)) {
    return unsupported('probe response contains top-level error');
  }

  const content = input.endpoint === 'chat'
    ? extractChatContent(body)
    : input.endpoint === 'messages'
      ? extractMessagesContent(body)
      : extractResponsesContent(body);

  if (!content.trim()) {
    return inconclusive('probe response contains no usable content');
  }

  return {
    status: 'supported',
    failureKind: null,
    reason: 'probe response contains protocol-native content',
  };
}
