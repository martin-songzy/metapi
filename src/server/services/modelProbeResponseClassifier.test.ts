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

  /**
   * The three cases below were ONE test that supplied a top-level `error` *and* a
   * matching keyword in the same body, so it passed whether the error branch
   * consulted the keyword list or ignored it. Splitting shape from keyword is what
   * makes the distinction observable — the same split the e2e test needed.
   */
  it('classifies a top-level error carrying a configured keyword as unsupported', () => {
    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: JSON.stringify({ error: { message: 'no available channel' } }),
      errorKeywords: ['no available channel'],
    })).toMatchObject({ status: 'unsupported', failureKind: 'error_body' });

    // String-valued `error` is the same shape and must reach the same verdict.
    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: JSON.stringify({ error: 'model_not_found' }),
      errorKeywords: ['model_not_found'],
    })).toMatchObject({ status: 'unsupported', failureKind: 'error_body' });
  });

  it('classifies a configured keyword outside any top-level error as unsupported', () => {
    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: JSON.stringify({ message: 'MODEL UNAVAILABLE' }),
      errorKeywords: ['model unavailable'],
    })).toMatchObject({ status: 'unsupported', failureKind: 'error_body' });
  });

  /**
   * The fail-safe direction. `unsupported` is the only verdict that writes
   * persistent, site-wide state (`site_disabled_models` has no auto-clear), so an
   * error nobody configured a keyword for must read as "unclear", not "the model is
   * gone". Account-level and transient wording is exactly what lands here.
   */
  it('leaves an unrecognized top-level error inconclusive rather than unsupported', () => {
    const accountLevelBodies = [
      { error: { message: '余额不足，请充值' } },
      { error: { message: '当前分组上游负载已饱和' } },
      { error: { message: 'Rate limit exceeded, retry later' } },
      { error: { message: 'Invalid API key provided' } },
      { error: { message: 'upstream server error (500)' } },
      { error: 'quota exhausted' },
    ];

    for (const body of accountLevelBodies) {
      const result = classifySuccessfulProbeResponse({
        endpoint: 'chat',
        rawBody: JSON.stringify(body),
        // A non-empty list that deliberately does not match: proves the verdict
        // comes from consulting the list, not from having no list at all.
        errorKeywords: ['no such model', '模型不存在'],
      });

      expect(result).toMatchObject({ status: 'inconclusive', failureKind: 'error_body' });
      // Paired with the negative so the assertion cannot pass by returning some
      // third thing: an error body must NEVER read as available.
      expect(result.status).not.toBe('supported');
    }
  });

  it('never reports an error body as supported, even when it also carries content', () => {
    // A relay that answers 200 with BOTH an error and a filled `choices` array
    // must not be read off the content: the error is the authoritative half.
    const result = classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: JSON.stringify({
        error: { message: 'billing suspended' },
        choices: [{ message: { content: 'this text must not win' } }],
      }),
      errorKeywords: ['no such model'],
    });

    expect(result.status).not.toBe('supported');
    expect(result).toMatchObject({ status: 'inconclusive', failureKind: 'error_body' });
  });

  it('classifies empty or non-protocol 2xx bodies as inconclusive unless configured keywords match', () => {
    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: JSON.stringify({ choices: [{ message: { content: '' } }] }),
    })).toMatchObject({ status: 'inconclusive', failureKind: 'empty_content' });

    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: JSON.stringify({ message: 'gateway healthy' }),
    })).toMatchObject({
      status: 'inconclusive',
      failureKind: 'empty_content',
      reason: 'invalid or non-JSON probe response',
    });

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

  it('requires explicit text-like block types for messages and responses content', () => {
    expect(classifySuccessfulProbeResponse({
      endpoint: 'messages',
      rawBody: JSON.stringify({ content: [{ type: 'thinking', text: 'not an answer' }] }),
    })).toMatchObject({
      status: 'inconclusive',
      failureKind: 'empty_content',
      reason: 'probe response contains no usable content',
    });

    expect(classifySuccessfulProbeResponse({
      endpoint: 'responses',
      rawBody: JSON.stringify({
        output: [{ content: [{ type: 'custom_block', text: 'not an answer' }] }],
      }),
    })).toMatchObject({
      status: 'inconclusive',
      failureKind: 'empty_content',
      reason: 'probe response contains no usable content',
    });
  });

  it('accepts top-level responses output_text', () => {
    expect(classifySuccessfulProbeResponse({
      endpoint: 'responses',
      rawBody: JSON.stringify({ output_text: 'OK' }),
    })).toMatchObject({ status: 'supported', failureKind: null });
  });

  it('does not treat a valid native answer containing a configured keyword as unsupported', () => {
    expect(classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: JSON.stringify({
        choices: [{ message: { content: 'The model unavailable error is explained here.' } }],
      }),
      errorKeywords: ['model unavailable'],
    })).toMatchObject({ status: 'supported', failureKind: null });
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

  it('caps a dynamic reason at exactly 1000 UTF-16 code units', () => {
    const keyword = 'x'.repeat(1_100);
    const result = classifySuccessfulProbeResponse({
      endpoint: 'chat',
      rawBody: keyword,
      errorKeywords: [keyword],
    });

    expect(result.reason.length).toBe(1_000);
  });
});
