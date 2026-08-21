import { describe, expect, it } from 'vitest';

import { classifySuccessfulProbeResponse } from './modelProbeResponseClassifier.js';

describe('classifySuccessfulProbeResponse', () => {
  it('classifies protocol-native text replies as supported', () => {
    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
    })).toMatchObject({ status: 'supported', failureKind: null });

    expect(classifySuccessfulProbeResponse({
      endpoint: 'messages',
      rawBody: JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }),
    })).toMatchObject({ status: 'supported', failureKind: null });

    expect(classifySuccessfulProbeResponse({
      endpoint: 'responses',
      rawBody: JSON.stringify({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'OK' }],
        }],
      }),
    })).toMatchObject({ status: 'supported', failureKind: null });
  });

  it('classifies explicit error bodies and configured error keywords as unsupported', () => {
    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: JSON.stringify({ error: { message: 'no available channel' } }),
      errorKeywords: ['no available channel'],
    })).toMatchObject({ status: 'unsupported', failureKind: 'error_body' });

    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: JSON.stringify({ message: 'MODEL UNAVAILABLE' }),
      errorKeywords: ['model unavailable'],
    })).toMatchObject({ status: 'unsupported', failureKind: 'error_body' });
  });

  it('classifies empty or non-protocol 2xx bodies as inconclusive unless configured keywords match', () => {
    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: JSON.stringify({ choices: [{ message: { content: '' } }] }),
    })).toMatchObject({ status: 'inconclusive', failureKind: 'empty_content' });

    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: '<html><body>temporarily unavailable</body></html>',
    })).toMatchObject({
      status: 'inconclusive',
      failureKind: 'empty_content',
      reason: 'invalid or non-JSON probe response',
    });

    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: '<html><body>NO AVAILABLE CHANNEL</body></html>',
      errorKeywords: ['no available channel'],
    })).toMatchObject({ status: 'unsupported', failureKind: 'error_body' });
  });

  it('does not treat answer text with an unconfigured generic error word as unsupported', () => {
    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: JSON.stringify({
        choices: [{ message: { content: 'Here is how to handle an error safely.' } }],
      }),
      errorKeywords: ['model unavailable'],
    })).toMatchObject({ status: 'supported', failureKind: null });
  });

  it('caps persisted reasons at 1000 UTF-16 code units', () => {
    const result = classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: `not-json-${'x'.repeat(1_100)}`,
    });

    expect(result.reason.length).toBeLessThanOrEqual(1_000);
  });
});
