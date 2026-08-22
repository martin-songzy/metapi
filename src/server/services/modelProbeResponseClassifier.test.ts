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

  /**
   * `JSON.stringify` emits raw UTF-8, so every other fixture in this file builds
   * bodies in the ONE encoding that already worked. JSON also permits `\uXXXX`,
   * and Python's `json.dumps` / FastAPI's `JSONResponse` escape non-ASCII BY
   * DEFAULT (`ensure_ascii=True`) — relays are commonly Python. Five of the eight
   * shipped default keywords are CJK, so on an escaping relay the keyword list
   * matched nothing and every model-absence reply read `inconclusive`.
   *
   * Written as escaped/literal PAIRS: the pair is what makes the property
   * "encoding does not change the verdict" observable at all.
   */
  describe('encoding independence', () => {
    const ESCAPED = '\\u6a21\\u578b\\u4e0d\\u5b58\\u5728';
    const LITERAL = '模型不存在';

    it('matches a CJK keyword that the upstream escaped as \\uXXXX', () => {
      // Guards the fixture itself: `ESCAPED` must be the escape sequence, not the
      // characters, or the pair below degenerates into the same test twice.
      expect(ESCAPED).not.toContain(LITERAL);
      expect(JSON.parse(`"${ESCAPED}"`)).toBe(LITERAL);

      for (const [name, rawBody] of [
        ['escaped', `{"error":{"message":"${ESCAPED}"}}`],
        ['literal', JSON.stringify({ error: { message: LITERAL } })],
      ] as const) {
        expect(classifySuccessfulProbeResponse({
          endpoint: 'chat',
          rawBody,
          errorKeywords: [LITERAL],
        }), name).toMatchObject({ status: 'unsupported', failureKind: 'error_body' });
      }
    });

    it('matches an escaped keyword in a string-valued error and in a bare JSON string body', () => {
      expect(classifySuccessfulProbeResponse({
        endpoint: 'chat',
        rawBody: `{"error":"${ESCAPED}"}`,
        errorKeywords: [LITERAL],
      })).toMatchObject({ status: 'unsupported', failureKind: 'error_body' });

      // Valid JSON that is not an object — the branch with no structure to scope to.
      expect(classifySuccessfulProbeResponse({
        endpoint: 'chat',
        rawBody: `"${ESCAPED}"`,
        errorKeywords: [LITERAL],
      })).toMatchObject({ status: 'unsupported', failureKind: 'error_body' });
    });

    it('matches an escaped keyword in a protocol-shaped body with no content', () => {
      expect(classifySuccessfulProbeResponse({
        endpoint: 'chat',
        rawBody: `{"choices":[{"message":{"content":""}}],"detail":"${ESCAPED}"}`,
        errorKeywords: [LITERAL],
      })).toMatchObject({ status: 'unsupported', failureKind: 'error_body' });
    });

    it('still leaves an escaped body no keyword recognizes inconclusive', () => {
      // The decoding must not become a way to match more loosely: an escaped body
      // whose wording nobody configured is still "unclear".
      expect(classifySuccessfulProbeResponse({
        endpoint: 'chat',
        rawBody: '{"error":{"message":"\\u4f59\\u989d\\u4e0d\\u8db3"}}',
        errorKeywords: [LITERAL],
      })).toMatchObject({ status: 'inconclusive', failureKind: 'error_body' });
    });
  });

  /**
   * A keyword ANYWHERE in the body used to promote an account-level error to
   * `unsupported`, the one verdict that writes persistent site-keyed state. The
   * keyword now has to appear in the error the relay actually reported.
   *
   * This NARROWS the search at this branch, which is a deliberate behaviour
   * change: a model-absence keyword living outside the error object no longer
   * reaches `unsupported`. That direction is the safe one — lost detection rather
   * than a wrong site-wide disable — and it is the same ruling the classifier
   * docblock already records for an unrecognized error.
   */
  describe('error-scoped keyword search', () => {
    it('ignores a keyword outside the reported error', () => {
      for (const [name, body] of [
        // The model name itself carrying the keyword.
        ['sibling model field', {
          error: { message: '余额不足，请充值' },
          model: 'test-model_not_found-probe',
        }],
        // The relay echoing the probe prompt back.
        ['echoed request', {
          error: { message: 'Rate limit exceeded' },
          request: { messages: [{ content: 'why does no such model exist?' }] },
        }],
      ] as const) {
        expect(classifySuccessfulProbeResponse({
          endpoint: 'chat',
          rawBody: JSON.stringify(body),
          errorKeywords: ['model_not_found', 'no such model'],
        }), name).toMatchObject({ status: 'inconclusive', failureKind: 'error_body' });
      }
    });

    it('still matches a keyword nested anywhere inside the reported error', () => {
      // Positive control for the narrowing: scoping must not shrink to
      // `error.message`. A two-layer relay error quoting its upstream is the shape
      // that matters, and it is a real one.
      for (const [name, error] of [
        ['nested upstream field', { message: '余额不足', upstream_error: '无可用渠道' }],
        ['code beside the message', { message: 'bad request', code: 'model_not_found' }],
      ] as const) {
        expect(classifySuccessfulProbeResponse({
          endpoint: 'chat',
          rawBody: JSON.stringify({ error }),
          errorKeywords: ['model_not_found', '无可用渠道'],
        }), name).toMatchObject({ status: 'unsupported', failureKind: 'error_body' });
      }
    });
  });

  /**
   * Minor 3 from the review: the docblock's property was true only for string- and
   * object-valued `error`. `isJsonObject` excludes arrays, so an array/boolean/
   * numeric `error`, or a body using `errors`, fell past the branch and reached
   * `supported` off its content — the false-positive class this feature exists to
   * remove.
   */
  describe('shapes that announce an error at top level', () => {
    const CONTENT = { choices: [{ message: { content: 'this text must not win' } }] };

    it('never reads as supported when an error is announced in any of these shapes', () => {
      for (const announced of [
        { error: [{ message: 'no such model' }] },
        { error: true },
        { error: 500 },
        { errors: [{ message: 'boom' }] },
        { errors: { message: 'boom' } },
        { error: 'plain string' },
        { error: { message: 'object' } },
      ]) {
        const result = classifySuccessfulProbeResponse({
          endpoint: 'chat',
          rawBody: JSON.stringify({ ...announced, ...CONTENT }),
          errorKeywords: ['no such model'],
        });

        expect(result.status, JSON.stringify(announced)).not.toBe('supported');
        expect(result.failureKind, JSON.stringify(announced)).toBe('error_body');
      }
    });

    it('treats the conventional "no error" sentinels as no error at all', () => {
      // The other half, and the reason the guard is not simply "an `error` key
      // exists": relays and SDK wrappers really do emit these next to a good
      // answer, and reading them as errors would turn working models into
      // `inconclusive` — losing the verdict this feature exists to produce.
      for (const sentinel of [
        { error: null },
        { error: false },
        { error: 0 },
        { error: [] },
        { errors: [] },
        {},
      ]) {
        expect(classifySuccessfulProbeResponse({
          endpoint: 'chat',
          rawBody: JSON.stringify({ ...sentinel, ...CONTENT }),
          errorKeywords: ['no such model'],
        }), JSON.stringify(sentinel)).toMatchObject({ status: 'supported', failureKind: null });
      }
    });
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
