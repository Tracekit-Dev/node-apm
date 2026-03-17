import * as api from '@opentelemetry/api';

/**
 * LLM instrumentation configuration
 */
export interface LLMConfig {
  /** Master toggle for LLM instrumentation (default: true) */
  enabled?: boolean;
  /** Enable OpenAI instrumentation (default: true) */
  openai?: boolean;
  /** Enable Anthropic instrumentation (default: true) */
  anthropic?: boolean;
  /** Capture prompt/completion content (default: false) */
  captureContent?: boolean;
}

// PII scrubbing pattern using letter-based boundaries (NOT \b)
// Matches sensitive field names regardless of surrounding underscores
const PII_PATTERN =
  /(?:^|[^a-zA-Z])(password|passwd|pwd|secret|token|key|credential|api_key|apikey)(?:[^a-zA-Z]|$)/gi;

/**
 * Resolve whether content capture is enabled.
 * Environment variable TRACEKIT_LLM_CAPTURE_CONTENT overrides config.
 */
export function resolveCaptureContent(config: LLMConfig): boolean {
  const envVal = process.env.TRACEKIT_LLM_CAPTURE_CONTENT;
  if (envVal !== undefined) {
    return envVal.toLowerCase() === 'true' || envVal === '1';
  }
  return config.captureContent ?? false;
}

/**
 * Scrub PII from content strings before recording on spans.
 * Replaces values of keys matching sensitive patterns with [REDACTED].
 */
export function scrubPII(content: string): string {
  // Try to parse as JSON and scrub values for sensitive keys
  try {
    const parsed = JSON.parse(content);
    const scrubbed = scrubObject(parsed);
    return JSON.stringify(scrubbed);
  } catch {
    // Not valid JSON, scrub inline patterns
    return content.replace(PII_PATTERN, (match) => {
      return match.replace(/(?<=:?\s*["']?)[^"',}\]\s]+/, '[REDACTED]');
    });
  }
}

function scrubObject(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(scrubObject);
  if (typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (PII_PATTERN.test(key)) {
        // Reset lastIndex since we use the 'g' flag
        PII_PATTERN.lastIndex = 0;
        result[key] = '[REDACTED]';
      } else {
        PII_PATTERN.lastIndex = 0;
        result[key] = scrubObject(value);
      }
    }
    return result;
  }
  return obj;
}

/**
 * Set GenAI request attributes on a span
 */
export function setGenAIRequestAttributes(
  span: api.Span,
  attrs: {
    model: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  }
): void {
  span.setAttribute('gen_ai.operation.name', 'chat');
  span.setAttribute('gen_ai.request.model', attrs.model);
  if (attrs.maxTokens !== undefined && attrs.maxTokens !== null) {
    span.setAttribute('gen_ai.request.max_tokens', attrs.maxTokens);
  }
  if (attrs.temperature !== undefined && attrs.temperature !== null) {
    span.setAttribute('gen_ai.request.temperature', attrs.temperature);
  }
  if (attrs.topP !== undefined && attrs.topP !== null) {
    span.setAttribute('gen_ai.request.top_p', attrs.topP);
  }
}

/**
 * Set GenAI response attributes on a span
 */
export function setGenAIResponseAttributes(
  span: api.Span,
  attrs: {
    model?: string;
    id?: string;
    finishReasons?: string[];
    inputTokens?: number;
    outputTokens?: number;
  }
): void {
  if (attrs.model) {
    span.setAttribute('gen_ai.response.model', attrs.model);
  }
  if (attrs.id) {
    span.setAttribute('gen_ai.response.id', attrs.id);
  }
  if (attrs.finishReasons && attrs.finishReasons.length > 0) {
    span.setAttribute('gen_ai.response.finish_reasons', attrs.finishReasons);
  }
  if (attrs.inputTokens !== undefined && attrs.inputTokens !== null) {
    span.setAttribute('gen_ai.usage.input_tokens', attrs.inputTokens);
  }
  if (attrs.outputTokens !== undefined && attrs.outputTokens !== null) {
    span.setAttribute('gen_ai.usage.output_tokens', attrs.outputTokens);
  }
}

/**
 * Set error attributes on a span for a GenAI error
 */
export function setGenAIErrorAttributes(span: api.Span, error: any): void {
  const errorType = error?.constructor?.name || 'Error';
  span.setAttribute('error.type', errorType);
  span.setStatus({ code: api.SpanStatusCode.ERROR, message: error?.message || String(error) });
  if (error instanceof Error) {
    span.recordException(error);
  }
}

/**
 * Record a tool call as a span event
 */
export function recordToolCallEvent(
  span: api.Span,
  toolCall: { name: string; id?: string; arguments?: string }
): void {
  const eventAttrs: Record<string, string> = {
    'gen_ai.tool.name': toolCall.name,
  };
  if (toolCall.id) {
    eventAttrs['gen_ai.tool.call.id'] = toolCall.id;
  }
  if (toolCall.arguments) {
    eventAttrs['gen_ai.tool.call.arguments'] = toolCall.arguments;
  }
  span.addEvent('gen_ai.tool.call', eventAttrs);
}

/**
 * Capture input messages on span (only when captureContent is enabled)
 */
export function captureInputMessages(span: api.Span, messages: any): void {
  if (messages) {
    const serialized = JSON.stringify(messages);
    span.setAttribute('gen_ai.input.messages', scrubPII(serialized));
  }
}

/**
 * Capture output messages on span (only when captureContent is enabled)
 */
export function captureOutputMessages(span: api.Span, content: any): void {
  if (content) {
    const serialized = JSON.stringify(content);
    span.setAttribute('gen_ai.output.messages', scrubPII(serialized));
  }
}

/**
 * Capture system instructions on span (only when captureContent is enabled)
 */
export function captureSystemInstructions(span: api.Span, system: any): void {
  if (system) {
    const serialized = typeof system === 'string' ? system : JSON.stringify(system);
    span.setAttribute('gen_ai.system_instructions', scrubPII(serialized));
  }
}
