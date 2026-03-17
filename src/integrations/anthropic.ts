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
 * Instrument Anthropic messages.create with GenAI semantic convention spans.
 * Monkey-patches Anthropic.Messages.prototype.create.
 * Returns true if Anthropic SDK was found and patched, false if not installed.
 */
export function instrumentAnthropic(tracer: api.Tracer, config: LLMConfig): boolean {
  let anthropicModule: any;
  try {
    anthropicModule = require('@anthropic-ai/sdk');
  } catch {
    return false; // anthropic not installed, skip silently
  }

  // Locate the Messages prototype to patch
  const MessagesProto =
    anthropicModule?.Anthropic?.Messages?.prototype ??
    anthropicModule?.default?.Messages?.prototype ??
    anthropicModule?.Messages?.prototype;

  if (!MessagesProto || typeof MessagesProto.create !== 'function') {
    return false; // unexpected structure, skip
  }

  const originalCreate = MessagesProto.create;
  const captureContent = config.captureContent ?? false;

  MessagesProto.create = async function patchedCreate(
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
      span.setAttribute('gen_ai.provider.name', 'anthropic');

      setGenAIRequestAttributes(span, {
        model,
        maxTokens: body?.max_tokens,
        temperature: body?.temperature,
        topP: body?.top_p,
      });

      // Capture content if enabled
      if (captureContent) {
        if (body?.system) {
          captureSystemInstructions(span, body.system);
        }
        if (body?.messages) {
          captureInputMessages(span, body.messages);
        }
      }

      const result = await originalCreate.call(this, body, options);

      if (isStreaming) {
        return wrapAnthropicStream(result, span, captureContent);
      }

      // Non-streaming response
      handleAnthropicNonStreamingResponse(span, result, captureContent);
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
 * Handle non-streaming Anthropic response
 */
function handleAnthropicNonStreamingResponse(
  span: api.Span,
  result: any,
  captureContent: boolean
): void {
  try {
    setGenAIResponseAttributes(span, {
      model: result?.model,
      id: result?.id,
      finishReasons: result?.stop_reason ? [result.stop_reason] : undefined,
      inputTokens: result?.usage?.input_tokens,
      outputTokens: result?.usage?.output_tokens,
    });

    // Anthropic-specific cache token attributes
    if (result?.usage?.cache_creation_input_tokens !== undefined) {
      span.setAttribute(
        'gen_ai.usage.cache_creation.input_tokens',
        result.usage.cache_creation_input_tokens
      );
    }
    if (result?.usage?.cache_read_input_tokens !== undefined) {
      span.setAttribute(
        'gen_ai.usage.cache_read.input_tokens',
        result.usage.cache_read_input_tokens
      );
    }

    // Record tool calls as span events
    const contentBlocks = result?.content || [];
    for (const block of contentBlocks) {
      if (block?.type === 'tool_use') {
        recordToolCallEvent(span, {
          name: block.name || 'unknown',
          id: block.id,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        });
      }
    }

    // Capture output content if enabled
    if (captureContent && contentBlocks.length > 0) {
      captureOutputMessages(span, contentBlocks);
    }
  } catch (_e) {
    // Never break user code
  }

  span.end();
}

/**
 * Wrap an Anthropic streaming response to accumulate token usage
 * and set span attributes when the stream completes.
 * Anthropic SDK streaming events include:
 * - message_start: contains usage.input_tokens
 * - content_block_start, content_block_delta: content chunks
 * - message_delta: contains usage.output_tokens and stop_reason
 * - message_stop: stream complete
 */
function wrapAnthropicStream(
  stream: any,
  span: api.Span,
  captureContent: boolean
): any {
  let responseModel: string | undefined;
  let responseId: string | undefined;
  let stopReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  const outputChunks: string[] = [];
  const toolCalls: Map<number, { name: string; id?: string; arguments: string }> = new Map();
  let currentBlockIndex = 0;

  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    const originalIterator = stream[Symbol.asyncIterator].bind(stream);

    const wrappedStream = Object.create(stream);

    wrappedStream[Symbol.asyncIterator] = function () {
      const iterator = originalIterator();
      return {
        async next(): Promise<IteratorResult<any>> {
          try {
            const result = await iterator.next();

            if (result.done) {
              finalizeStreamSpan();
              return result;
            }

            const event = result.value;
            processAnthropicEvent(event);

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

    // Preserve stream methods for transparency
    if (typeof stream.toReadableStream === 'function') {
      wrappedStream.toReadableStream = stream.toReadableStream.bind(stream);
    }

    return wrappedStream;
  }

  // Fallback: not async iterable
  span.end();
  return stream;

  function processAnthropicEvent(event: any): void {
    try {
      const eventType = event?.type || event?.event;

      switch (eventType) {
        case 'message_start': {
          const message = event?.message;
          if (message) {
            responseModel = message.model;
            responseId = message.id;
            if (message.usage) {
              inputTokens = message.usage.input_tokens;
              if (message.usage.cache_creation_input_tokens !== undefined) {
                cacheCreationTokens = message.usage.cache_creation_input_tokens;
              }
              if (message.usage.cache_read_input_tokens !== undefined) {
                cacheReadTokens = message.usage.cache_read_input_tokens;
              }
            }
          }
          break;
        }

        case 'content_block_start': {
          currentBlockIndex = event?.index ?? currentBlockIndex;
          const contentBlock = event?.content_block;
          if (contentBlock?.type === 'tool_use') {
            toolCalls.set(currentBlockIndex, {
              name: contentBlock.name || 'unknown',
              id: contentBlock.id,
              arguments: '',
            });
          }
          break;
        }

        case 'content_block_delta': {
          const delta = event?.delta;
          if (delta) {
            if (delta.type === 'text_delta' && captureContent && delta.text) {
              outputChunks.push(delta.text);
            }
            if (delta.type === 'input_json_delta' && delta.partial_json) {
              const idx = event?.index ?? currentBlockIndex;
              const existing = toolCalls.get(idx);
              if (existing) {
                existing.arguments += delta.partial_json;
              }
            }
          }
          break;
        }

        case 'message_delta': {
          const delta = event?.delta;
          if (delta?.stop_reason) {
            stopReason = delta.stop_reason;
          }
          const usage = event?.usage;
          if (usage?.output_tokens !== undefined) {
            outputTokens = usage.output_tokens;
          }
          break;
        }
      }
    } catch (_e) {
      // Never fail on event processing
    }
  }

  function finalizeStreamSpan(): void {
    try {
      setGenAIResponseAttributes(span, {
        model: responseModel,
        id: responseId,
        finishReasons: stopReason ? [stopReason] : undefined,
        inputTokens,
        outputTokens,
      });

      // Anthropic-specific cache tokens
      if (cacheCreationTokens !== undefined) {
        span.setAttribute('gen_ai.usage.cache_creation.input_tokens', cacheCreationTokens);
      }
      if (cacheReadTokens !== undefined) {
        span.setAttribute('gen_ai.usage.cache_read.input_tokens', cacheReadTokens);
      }

      // Record accumulated tool calls
      for (const [, tc] of toolCalls) {
        recordToolCallEvent(span, tc);
      }

      // Capture accumulated output
      if (captureContent && outputChunks.length > 0) {
        const fullContent = outputChunks.join('');
        captureOutputMessages(span, [{ type: 'text', text: fullContent }]);
      }
    } catch (_e) {
      // Never break user code
    }

    span.end();
  }
}
