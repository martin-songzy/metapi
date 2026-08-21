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
  const normalizedBody = rawBody.toLocaleLowerCase();
  return errorKeywords.find((keyword) => keyword && normalizedBody.includes(keyword.toLocaleLowerCase())) ?? null;
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

  if (typeof body.error === 'string' || isJsonObject(body.error)) {
    return unsupported('probe response contains top-level error');
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
