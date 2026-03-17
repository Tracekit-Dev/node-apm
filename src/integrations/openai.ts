import * as api from '@opentelemetry/api';
import {
  LLMConfig,
  setGenAIRequestAttributes,
  setGenAIResponseAttributes,
  setGenAIErrorAttributes,
  recordToolCallEvent,
  captureInputMessages,
  captureOutputMessages,
  captureSystemInstructions,
} from './llm-common';

/**
 * Instrument OpenAI chat.completions.create with GenAI semantic convention spans.
 * Monkey-patches OpenAI.Chat.Completions.prototype.create.
 * Returns true if OpenAI was found and patched, false if not installed.
 */
export function instrumentOpenAI(tracer: api.Tracer, config: LLMConfig): boolean {
  let openaiModule: any;
  try {
    openaiModule = require('openai');
  } catch {
    return false; // openai not installed, skip silently
  }

  // Locate the Completions prototype to patch
  const CompletionsProto =
    openaiModule?.OpenAI?.Chat?.Completions?.prototype ??
    openaiModule?.default?.Chat?.Completions?.prototype;

  if (!CompletionsProto || typeof CompletionsProto.create !== 'function') {
    return false; // unexpected structure, skip
  }

  const originalCreate = CompletionsProto.create;
  const captureContent = config.captureContent ?? false;

  CompletionsProto.create = async function patchedCreate(
    this: any,
    body: any,
    options?: any
  ) {
    const model = body?.model || 'unknown';
    const isStreaming = !!body?.stream;

    const span = tracer.startSpan(`chat ${model}`, {
      kind: api.SpanKind.CLIENT,
    });

    try {
      span.setAttribute('gen_ai.provider.name', 'openai');

      setGenAIRequestAttributes(span, {
        model,
        maxTokens: body?.max_tokens ?? body?.max_completion_tokens,
        temperature: body?.temperature,
        topP: body?.top_p,
      });

      // Capture content if enabled
      if (captureContent) {
        if (body?.messages) {
          // Separate system messages for system_instructions attribute
          const systemMessages = body.messages.filter((m: any) => m.role === 'system');
          const nonSystemMessages = body.messages.filter((m: any) => m.role !== 'system');

          if (systemMessages.length > 0) {
            captureSystemInstructions(span, systemMessages);
          }
          captureInputMessages(span, nonSystemMessages);
        }
      }

      // For streaming, inject stream_options.include_usage if not set
      // This ensures we get token usage in the final chunk
      let modifiedBody = body;
      if (isStreaming) {
        modifiedBody = { ...body };
        if (!modifiedBody.stream_options) {
          modifiedBody.stream_options = { include_usage: true };
        } else if (modifiedBody.stream_options.include_usage === undefined) {
          modifiedBody.stream_options = {
            ...modifiedBody.stream_options,
            include_usage: true,
          };
        }
      }

      const result = await originalCreate.call(this, modifiedBody, options);

      if (isStreaming) {
        return wrapOpenAIStream(result, span, captureContent);
      }

      // Non-streaming response
      handleOpenAINonStreamingResponse(span, result, captureContent);
      return result;
    } catch (error: any) {
      setGenAIErrorAttributes(span, error);
      span.end();
      throw error;
    }
  };

  return true;
}

/**
 * Handle non-streaming OpenAI response: extract attributes, record tool calls, end span
 */
function handleOpenAINonStreamingResponse(
  span: api.Span,
  result: any,
  captureContent: boolean
): void {
  try {
    setGenAIResponseAttributes(span, {
      model: result?.model,
      id: result?.id,
      finishReasons: result?.choices?.map((c: any) => c.finish_reason).filter(Boolean),
      inputTokens: result?.usage?.prompt_tokens,
      outputTokens: result?.usage?.completion_tokens,
    });

    // System fingerprint (OpenAI-specific)
    if (result?.system_fingerprint) {
      span.setAttribute('openai.response.system_fingerprint', result.system_fingerprint);
    }

    // Record tool calls as span events
    const choices = result?.choices || [];
    for (const choice of choices) {
      const toolCalls = choice?.message?.tool_calls || [];
      for (const tc of toolCalls) {
        recordToolCallEvent(span, {
          name: tc?.function?.name || 'unknown',
          id: tc?.id,
          arguments: tc?.function?.arguments,
        });
      }
    }

    // Capture output content if enabled
    if (captureContent && choices.length > 0) {
      const outputMessages = choices.map((c: any) => c.message).filter(Boolean);
      if (outputMessages.length > 0) {
        captureOutputMessages(span, outputMessages);
      }
    }
  } catch (_e) {
    // Never break user code due to attribute extraction
  }

  span.end();
}

/**
 * Wrap an OpenAI streaming response to accumulate token usage
 * and set span attributes when the stream completes.
 * The wrapper transparently passes through all chunks to user code.
 */
function wrapOpenAIStream(
  stream: any,
  span: api.Span,
  captureContent: boolean
): any {
  let responseModel: string | undefined;
  let responseId: string | undefined;
  let finishReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let systemFingerprint: string | undefined;
  const outputChunks: string[] = [];
  const toolCalls: Map<number, { name: string; id?: string; arguments: string }> = new Map();

  // Check if the stream is an async iterable (OpenAI SDK v4+ returns Stream objects)
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    const originalIterator = stream[Symbol.asyncIterator].bind(stream);

    // Create a proxy that wraps the async iterator
    const wrappedStream = Object.create(stream);

    wrappedStream[Symbol.asyncIterator] = function () {
      const iterator = originalIterator();
      return {
        async next(): Promise<IteratorResult<any>> {
          try {
            const result = await iterator.next();

            if (result.done) {
              // Stream complete - finalize span
              finalizeStreamSpan();
              return result;
            }

            const chunk = result.value;
            processOpenAIChunk(chunk);

            return result;
          } catch (error: any) {
            setGenAIErrorAttributes(span, error);
            span.end();
            throw error;
          }
        },
        async return(value?: any): Promise<IteratorResult<any>> {
          finalizeStreamSpan();
          if (iterator.return) {
            return iterator.return(value);
          }
          return { done: true, value };
        },
        async throw(error?: any): Promise<IteratorResult<any>> {
          setGenAIErrorAttributes(span, error);
          span.end();
          if (iterator.throw) {
            return iterator.throw(error);
          }
          throw error;
        },
      };
    };

    // Preserve any methods on the original stream (e.g., controller, abort)
    // This ensures the wrapper is transparent to user code
    if (typeof stream.toReadableStream === 'function') {
      wrappedStream.toReadableStream = stream.toReadableStream.bind(stream);
    }
    if (typeof stream.controller === 'object') {
      wrappedStream.controller = stream.controller;
    }

    return wrappedStream;
  }

  // Fallback: if stream is not async iterable, just end span and return as-is
  span.end();
  return stream;

  function processOpenAIChunk(chunk: any): void {
    try {
      // Extract model and id from chunks
      if (chunk?.model) responseModel = chunk.model;
      if (chunk?.id) responseId = chunk.id;
      if (chunk?.system_fingerprint) systemFingerprint = chunk.system_fingerprint;

      // Extract usage from the final chunk (when stream_options.include_usage is set)
      if (chunk?.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }

      // Process choices
      const choices = chunk?.choices || [];
      for (const choice of choices) {
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }

        // Accumulate content for capture
        const delta = choice?.delta;
        if (delta) {
          if (captureContent && delta.content) {
            outputChunks.push(delta.content);
          }

          // Accumulate tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCalls.get(idx);
              if (existing) {
                if (tc.function?.arguments) {
                  existing.arguments += tc.function.arguments;
                }
              } else {
                toolCalls.set(idx, {
                  name: tc.function?.name || 'unknown',
                  id: tc.id,
                  arguments: tc.function?.arguments || '',
                });
              }
            }
          }
        }
      }
    } catch (_e) {
      // Never fail on chunk processing
    }
  }

  function finalizeStreamSpan(): void {
    try {
      setGenAIResponseAttributes(span, {
        model: responseModel,
        id: responseId,
        finishReasons: finishReason ? [finishReason] : undefined,
        inputTokens,
        outputTokens,
      });

      if (systemFingerprint) {
        span.setAttribute('openai.response.system_fingerprint', systemFingerprint);
      }

      // Record accumulated tool calls as span events
      for (const [, tc] of toolCalls) {
        recordToolCallEvent(span, tc);
      }

      // Capture accumulated output if enabled
      if (captureContent && outputChunks.length > 0) {
        const fullContent = outputChunks.join('');
        captureOutputMessages(span, [{ role: 'assistant', content: fullContent }]);
      }
    } catch (_e) {
      // Never break user code
    }

    span.end();
  }
}
