import * as http from 'http';
import { getRequestContext } from './middleware/express';

export interface BreakpointConfig {
  id: string;
  service_name: string;
  file_path: string;
  function_name: string;
  label?: string;
  line_number: number;
  condition?: string;
  max_captures: number;
  capture_count: number;
  expire_at?: Date;
  enabled: boolean;
}

export interface SecurityFlag {
  type: string;
  severity: string;
  variable?: string;
}

export interface Snapshot {
  breakpoint_id?: string;
  service_name: string;
  file_path: string;
  function_name: string;
  label?: string;
  line_number: number;
  variables: Record<string, any>;
  security_flags?: SecurityFlag[];
  stack_trace: string;
  trace_id?: string;
  span_id?: string;
  request_context?: Record<string, any>;
  captured_at: Date;
}

/** A custom PII pattern with its typed redaction marker */
export interface PIIPatternEntry {
  pattern: RegExp;
  marker: string; // e.g., "[REDACTED:email]"
}

/**
 * Opt-in capture limit configuration.
 * All limits are disabled by default (undefined = unlimited).
 */
export interface CaptureConfig {
  /** Max nesting depth for captured variables. undefined = unlimited (default). */
  captureDepth?: number;
  /** Max serialized payload size in bytes. undefined = unlimited (default). */
  maxPayload?: number;
  /** Capture timeout in milliseconds. undefined = no timeout (default). */
  captureTimeout?: number;
  /** Enable debug logging. */
  debug?: boolean;
  /** Whether PII scrubbing is enabled. Default: true. Set to false to disable. */
  piiScrubbing?: boolean;
  /** Additional custom PII patterns appended to the built-in 13-pattern set. */
  piiPatterns?: PIIPatternEntry[];
  /** Circuit breaker configuration. Undefined = use defaults (3 failures in 60s, 5min cooldown). */
  circuitBreaker?: CircuitBreakerConfig;
}

/** Circuit breaker configuration for snapshot HTTP calls */
export interface CircuitBreakerConfig {
  /** Max failures before tripping (default: 3) */
  maxFailures?: number;
  /** Failure counting window in ms (default: 60000) */
  windowMs?: number;
  /** Cooldown period in ms before auto-resume (default: 300000) */
  cooldownMs?: number;
}

/** Built-in PII patterns -- compiled once, shared across all scans */
const DEFAULT_PII_PATTERNS: PIIPatternEntry[] = [
  { pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/, marker: '[REDACTED:email]' },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, marker: '[REDACTED:ssn]' },
  { pattern: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, marker: '[REDACTED:credit_card]' },
  { pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, marker: '[REDACTED:phone]' },
  { pattern: /AKIA[0-9A-Z]{16}/, marker: '[REDACTED:aws_key]' },
  { pattern: /aws.{0,20}secret.{0,20}[A-Za-z0-9/+=]{40}/i, marker: '[REDACTED:aws_secret]' },
  { pattern: /(?:bearer\s+)[A-Za-z0-9._~+/=\-]{20,}/i, marker: '[REDACTED:oauth_token]' },
  { pattern: /sk_live_[0-9a-zA-Z]{10,}/, marker: '[REDACTED:stripe_key]' },
  { pattern: /(?:password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{6,}/i, marker: '[REDACTED:password]' },
  { pattern: /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/, marker: '[REDACTED:jwt]' },
  { pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, marker: '[REDACTED:private_key]' },
  { pattern: /(?:api[_\-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}/i, marker: '[REDACTED:api_key]' },
];

/** Letter-boundary pattern for sensitive variable names.
 * \b treats _ as a word char, so api_key and user_token wouldn't match.
 * Use letter-based boundaries to catch underscore-separated names. */
const SENSITIVE_NAME_PATTERN = /(?:^|[^a-zA-Z])(password|passwd|pwd|secret|token|key|credential|api_key|apikey)(?:[^a-zA-Z]|$)/i;

export class SnapshotClient {
  private apiKey: string;
  private baseURL: string;
  private serviceName: string;
  private breakpointsCache: Map<string, BreakpointConfig> = new Map();
  private registrationCache: Set<string> = new Set();
  private pollInterval?: NodeJS.Timeout;
  private lastFetch?: Date;
  private captureConfig: CaptureConfig;
  private piiPatterns: PIIPatternEntry[];

  // Circuit breaker state
  private circuitBreakerState: 'closed' | 'open' = 'closed';
  private circuitBreakerOpenedAt: number | null = null;
  private circuitBreakerFailureTimestamps: number[] = [];
  private circuitBreakerMaxFailures: number;
  private circuitBreakerWindowMs: number;
  private circuitBreakerCooldownMs: number;
  private pendingEvents: Record<string, any>[] = [];

  // Kill switch: server-initiated monitoring disable
  private killSwitchActive: boolean = false;
  private normalPollMs: number = 30000;
  private killSwitchPollMs: number = 60000;

  // SSE (Server-Sent Events) real-time updates
  private sseEndpoint: string | null = null;
  private sseActive: boolean = false;
  private sseAbortController: AbortController | null = null;

  constructor(apiKey: string, baseURL: string, serviceName: string, captureConfig?: CaptureConfig) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.serviceName = serviceName;
    this.captureConfig = captureConfig || {};
    // Compile PII patterns once: built-in + any custom patterns
    this.piiPatterns = [
      ...DEFAULT_PII_PATTERNS,
      ...(this.captureConfig.piiPatterns || []),
    ];
    // Initialize circuit breaker with config or defaults
    const cbConfig = this.captureConfig.circuitBreaker || {};
    this.circuitBreakerMaxFailures = cbConfig.maxFailures ?? 3;
    this.circuitBreakerWindowMs = cbConfig.windowMs ?? 60000;
    this.circuitBreakerCooldownMs = cbConfig.cooldownMs ?? 300000;
  }

  /** Update capture limit configuration */
  setCaptureConfig(config: CaptureConfig): void {
    this.captureConfig = config;
  }

  // Start background polling
  start(): void {
    this.fetchActiveBreakpoints(); // Immediate fetch
    this.schedulePoll();
    console.log(`📸 TraceKit Snapshot Client started for service: ${this.serviceName}`);
  }

  // Schedule poll with appropriate interval based on kill switch state
  private schedulePoll(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    const interval = this.killSwitchActive ? this.killSwitchPollMs : this.normalPollMs;
    this.pollInterval = setInterval(
      () => this.fetchActiveBreakpoints(),
      interval
    );
  }

  // Stop polling and SSE
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
    this.sseActive = false;
    console.log('📸 TraceKit Snapshot Client stopped');
  }

  // Automatic capture with runtime detection
  // Crash isolation: never lets a TraceKit bug crash the host application
  async checkAndCaptureWithContext(
    label: string,
    variables: Record<string, any> = {}
  ): Promise<void> {
    // Kill switch: skip all capture when server has disabled monitoring
    if (this.killSwitchActive) {
      return;
    }

    try {
      // Apply capture timeout if configured
      if (this.captureConfig.captureTimeout && this.captureConfig.captureTimeout > 0) {
        return await Promise.race([
          this._doCheckAndCapture(label, variables),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('capture timeout')), this.captureConfig.captureTimeout)
          ),
        ]);
      }

      await this._doCheckAndCapture(label, variables);
    } catch (error) {
      // Never rethrow -- SDK should never crash the host app
      if (this.captureConfig.debug) {
        console.error('TraceKit: error in checkAndCaptureWithContext:', error);
      }
    }
  }

  private async _doCheckAndCapture(
    label: string,
    variables: Record<string, any>
  ): Promise<void> {
    // Get caller information using Error stack trace
    const stack = new Error().stack || '';
    const caller = this.parseStackTrace(stack);

    if (!caller) {
      if (this.captureConfig.debug) {
        console.warn('TraceKit: could not detect caller location');
      }
      return;
    }

    const { file, line, functionName } = caller;

    // Check if location is registered
    const locationKey = `${functionName}:${label}`;
    if (!this.registrationCache.has(locationKey)) {
      // Auto-register breakpoint
      const breakpoint = await this.autoRegisterBreakpoint({
        file_path: file,
        line_number: line,
        function_name: functionName,
        label,
      });

      if (breakpoint) {
        this.registrationCache.add(locationKey);
        this.breakpointsCache.set(locationKey, breakpoint);
      } else {
        return;
      }
    }

    // Check cache for active breakpoint
    const breakpoint = this.breakpointsCache.get(locationKey);
    if (!breakpoint || !breakpoint.enabled) {
      return;
    }

    // Check expiration
    if (breakpoint.expire_at && new Date() > breakpoint.expire_at) {
      return;
    }

    // Check max captures
    if (breakpoint.max_captures > 0 && breakpoint.capture_count >= breakpoint.max_captures) {
      return;
    }

    // Apply opt-in capture depth limit
    if (this.captureConfig.captureDepth && this.captureConfig.captureDepth > 0) {
      variables = this.limitDepth(variables, 0, this.captureConfig.captureDepth);
    }

    // Extract request context (from AsyncLocalStorage or global)
    const requestContext = this.extractRequestContext();

    // Scan variables for security issues
    const securityScan = this.scanForSecurityIssues(variables);

    // Safe serialize variables to check payload size
    const serializedVars = this.safeSerialize(securityScan.variables);

    // Apply opt-in payload size limit
    let finalVariables = securityScan.variables;
    if (this.captureConfig.maxPayload && this.captureConfig.maxPayload > 0) {
      const payloadSize = new TextEncoder().encode(serializedVars).length;
      if (payloadSize > this.captureConfig.maxPayload) {
        finalVariables = {
          _truncated: true,
          _payload_size: payloadSize,
          _max_payload: this.captureConfig.maxPayload,
        };
      }
    }

    // Create snapshot
    const snapshot: Snapshot = {
      breakpoint_id: breakpoint.id,
      service_name: this.serviceName,
      file_path: file,
      function_name: functionName,
      label,
      line_number: line,
      variables: finalVariables,
      security_flags: securityScan.flags,
      stack_trace: stack,
      request_context: requestContext,
      captured_at: new Date(),
    };

    // Send snapshot
    await this.captureSnapshot(snapshot);
  }

  // Parse Node.js stack trace to extract file, line, function
  private parseStackTrace(stack: string): {
    file: string;
    line: number;
    functionName: string;
  } | null {
    const lines = stack.split('\n');

    // Stack trace looks like:
    // 0: Error
    // 1: at SnapshotClient.checkAndCaptureWithContext (...)
    // 2: at TracekitClient.captureSnapshot (...) <- wrapper method
    // 3: at <actual caller> <- THIS IS WHAT WE WANT
    
    // Skip to line 3 to get the actual caller
    const callerLine = lines[3]?.trim();

    if (!callerLine) return null;

    // Parse format: "at FunctionName (file:line:col)" or "at file:line:col"
    const match = callerLine.match(/at\s+(?:([^\s]+)\s+\()?([^:]+):(\d+):\d+\)?/);

    if (!match) return null;

    const functionName = match[1] || 'anonymous';
    const file = match[2];
    const line = parseInt(match[3], 10);

    return { file, line, functionName };
  }

  // Fetch active breakpoints from backend, piggybacking any pending telemetry events
  private async fetchActiveBreakpoints(): Promise<void> {
    try {
      const url = `${this.baseURL}/sdk/snapshots/active/${this.serviceName}`;

      // Drain pending events to include in request
      const events = this.pendingEvents.splice(0);

      let response: Response;
      if (events.length > 0) {
        // POST with events in body
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'X-API-Key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ events }),
        });
      } else {
        response = await fetch(url, {
          headers: {
            'X-API-Key': this.apiKey,
          },
        });
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as { breakpoints?: BreakpointConfig[]; kill_switch?: boolean; sse_endpoint?: string };

      // Handle kill switch state (missing field = false for backward compat)
      const newKillState = data.kill_switch === true;
      if (newKillState && !this.killSwitchActive) {
        console.log('TraceKit: Code monitoring disabled by server kill switch. Polling at reduced frequency.');
      } else if (!newKillState && this.killSwitchActive) {
        console.log('TraceKit: Code monitoring re-enabled by server.');
      }
      if (newKillState !== this.killSwitchActive) {
        this.killSwitchActive = newKillState;
        this.schedulePoll(); // Adjust poll interval
      }

      // If kill-switched, close any active SSE connection
      if (this.killSwitchActive && this.sseActive && this.sseAbortController) {
        this.sseAbortController.abort();
        this.sseActive = false;
        console.log('TraceKit: SSE connection closed due to kill switch');
      }

      // SSE auto-discovery: if sse_endpoint present and not already connected, start SSE
      const breakpoints = data.breakpoints || [];
      if (data.sse_endpoint && !this.sseActive && !this.killSwitchActive && breakpoints.length > 0) {
        this.sseEndpoint = data.sse_endpoint;
        this.connectSSE(data.sse_endpoint);
      }

      this.updateBreakpointCache(breakpoints);
      this.lastFetch = new Date();
    } catch (error) {
      console.error('⚠️  Failed to fetch breakpoints:', error);
    }
  }

  // Connect to SSE endpoint for real-time breakpoint updates
  private async connectSSE(endpoint: string): Promise<void> {
    try {
      const fullURL = `${this.baseURL}${endpoint}`;
      this.sseAbortController = new AbortController();

      const response = await fetch(fullURL, {
        headers: {
          'X-API-Key': this.apiKey,
          'Accept': 'text/event-stream',
        },
        signal: this.sseAbortController.signal,
      });

      if (!response.ok) {
        console.warn(`TraceKit: SSE endpoint returned ${response.status}, falling back to polling`);
        this.sseActive = false;
        return;
      }

      this.sseActive = true;
      console.log('TraceKit: SSE connection established for real-time breakpoint updates');

      const reader = response.body?.getReader();
      if (!reader) {
        this.sseActive = false;
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';
      let dataBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last partial line in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            if (dataBuffer) dataBuffer += '\n';
            dataBuffer += line.slice(5).trim();
          } else if (line === '') {
            // Empty line = event boundary
            if (eventType && dataBuffer) {
              this.handleSSEEvent(eventType, dataBuffer);
            }
            eventType = '';
            dataBuffer = '';
          }
        }
      }

      console.log('TraceKit: SSE connection closed, falling back to polling');
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        console.warn('TraceKit: SSE connection lost, falling back to polling:', error?.message);
      }
    } finally {
      this.sseActive = false;
    }
  }

  // Handle a single SSE event
  private handleSSEEvent(eventType: string, data: string): void {
    try {
      switch (eventType) {
        case 'init': {
          const initData = JSON.parse(data) as {
            breakpoints: BreakpointConfig[];
            kill_switch: boolean;
          };
          this.updateBreakpointCache(initData.breakpoints);
          this.killSwitchActive = initData.kill_switch;
          if (this.killSwitchActive && this.sseAbortController) {
            this.sseAbortController.abort();
          }
          console.log(`TraceKit: SSE init received, ${initData.breakpoints.length} breakpoints loaded`);
          break;
        }

        case 'breakpoint_created':
        case 'breakpoint_updated': {
          const bp = JSON.parse(data) as BreakpointConfig;
          if (bp.label && bp.function_name) {
            const labelKey = `${bp.function_name}:${bp.label}`;
            this.breakpointsCache.set(labelKey, bp);
          }
          const lineKey = `${bp.file_path}:${bp.line_number}`;
          this.breakpointsCache.set(lineKey, bp);
          console.log(`TraceKit: SSE breakpoint ${eventType}: ${bp.id}`);
          break;
        }

        case 'breakpoint_deleted': {
          const deleteData = JSON.parse(data) as { id: string };
          for (const [key, bp] of this.breakpointsCache.entries()) {
            if (bp.id === deleteData.id) {
              this.breakpointsCache.delete(key);
            }
          }
          console.log(`TraceKit: SSE breakpoint deleted: ${deleteData.id}`);
          break;
        }

        case 'kill_switch': {
          const ksData = JSON.parse(data) as { enabled: boolean };
          this.killSwitchActive = ksData.enabled;
          if (ksData.enabled) {
            console.log('TraceKit: Kill switch enabled via SSE, closing connection');
            if (this.sseAbortController) {
              this.sseAbortController.abort();
            }
          }
          break;
        }

        case 'heartbeat':
          // No action needed -- keeps connection alive
          break;

        default:
          console.warn(`TraceKit: unknown SSE event type: ${eventType}`);
      }
    } catch (error) {
      console.error(`TraceKit: error handling SSE event ${eventType}:`, error);
    }
  }

  // Update in-memory cache
  private updateBreakpointCache(breakpoints: BreakpointConfig[]): void {
    this.breakpointsCache.clear();

    for (const bp of breakpoints) {
      // Primary key: function + label
      if (bp.label && bp.function_name) {
        const labelKey = `${bp.function_name}:${bp.label}`;
        this.breakpointsCache.set(labelKey, bp);
      }

      // Secondary key: file + line
      const lineKey = `${bp.file_path}:${bp.line_number}`;
      this.breakpointsCache.set(lineKey, bp);
    }

    if (breakpoints.length > 0) {
      console.log(`📸 Updated breakpoint cache: ${breakpoints.length} active breakpoints`);
    }
  }

  // Auto-register breakpoint
  private async autoRegisterBreakpoint(data: {
    file_path: string;
    line_number: number;
    function_name: string;
    label: string;
  }): Promise<BreakpointConfig | null> {
    try {
      const response = await fetch(`${this.baseURL}/sdk/snapshots/auto-register`, {
        method: 'POST',
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          service_name: this.serviceName,
          ...data,
        }),
      });

      if (!response.ok) {
        console.error('⚠️  Failed to auto-register breakpoint:', response.status);
        return null;
      }

      const result = await response.json() as BreakpointConfig;
      return result;
    } catch (error) {
      console.error('⚠️  Failed to auto-register breakpoint:', error);
      return null;
    }
  }

  // Circuit breaker: check if requests are allowed
  private shouldAllow(): boolean {
    if (this.circuitBreakerState === 'closed') {
      return true;
    }

    // State is "open" -- check if cooldown has elapsed
    if (this.circuitBreakerOpenedAt !== null) {
      const elapsed = Date.now() - this.circuitBreakerOpenedAt;
      if (elapsed >= this.circuitBreakerCooldownMs) {
        this.circuitBreakerState = 'closed';
        this.circuitBreakerFailureTimestamps = [];
        this.circuitBreakerOpenedAt = null;
        console.log('TraceKit: Code monitoring resumed');
        return true;
      }
    }

    return false;
  }

  // Circuit breaker: record an HTTP failure, returns true if circuit just tripped
  private recordFailure(): boolean {
    const now = Date.now();
    this.circuitBreakerFailureTimestamps.push(now);

    // Prune timestamps older than window
    const cutoff = now - this.circuitBreakerWindowMs;
    this.circuitBreakerFailureTimestamps = this.circuitBreakerFailureTimestamps.filter(ts => ts > cutoff);

    // Check if threshold exceeded
    if (
      this.circuitBreakerFailureTimestamps.length >= this.circuitBreakerMaxFailures &&
      this.circuitBreakerState === 'closed'
    ) {
      this.circuitBreakerState = 'open';
      this.circuitBreakerOpenedAt = now;
      console.warn(
        `TraceKit: Code monitoring paused (${this.circuitBreakerMaxFailures} capture failures in ${this.circuitBreakerWindowMs / 1000}s). Auto-resumes in ${this.circuitBreakerCooldownMs / 60000} min.`
      );
      return true;
    }

    return false;
  }

  // Queue a circuit breaker telemetry event for the next poll
  private queueCircuitBreakerEvent(): void {
    this.pendingEvents.push({
      type: 'circuit_breaker_tripped',
      service_name: this.serviceName,
      failure_count: this.circuitBreakerMaxFailures,
      window_seconds: this.circuitBreakerWindowMs / 1000,
      cooldown_seconds: this.circuitBreakerCooldownMs / 1000,
      timestamp: new Date().toISOString(),
    });
  }

  // Capture and send snapshot
  private async captureSnapshot(snapshot: Snapshot): Promise<void> {
    // Circuit breaker check
    if (!this.shouldAllow()) {
      return;
    }

    try {
      const response = await fetch(`${this.baseURL}/sdk/snapshots/capture`, {
        method: 'POST',
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(snapshot),
      });

      if (response.status >= 500) {
        // Server error -- count as circuit breaker failure
        console.error('⚠️  Failed to capture snapshot:', response.status);
        if (this.recordFailure()) {
          this.queueCircuitBreakerEvent();
        }
      } else if (!response.ok) {
        // Client error (4xx) -- do NOT count as circuit breaker failure
        console.error('⚠️  Failed to capture snapshot:', response.status);
      } else {
        console.log(`📸 Snapshot captured: ${snapshot.label || snapshot.file_path}`);
      }
    } catch (error) {
      // Network error -- count as circuit breaker failure
      console.error('⚠️  Failed to capture snapshot:', error);
      if (this.recordFailure()) {
        this.queueCircuitBreakerEvent();
      }
    }
  }

  // Extract request context from AsyncLocalStorage or global
  private extractRequestContext(): Record<string, any> | undefined {
    return getRequestContext();
  }

  // Sanitize variables for JSON serialization with circular reference handling
  private sanitizeVariables(variables: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(variables)) {
      try {
        // Use safe serialization to handle circular references
        this.safeSerialize(value);
        sanitized[key] = value;
      } catch {
        sanitized[key] = `[unserializable:${typeof value}]`;
      }
    }

    return sanitized;
  }

  // Safe JSON.stringify with circular reference detection
  private safeSerialize(value: any): string {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[circular reference]';
        }
        seen.add(val);
      }
      return val;
    });
  }

  // Limit variable nesting depth (opt-in)
  private limitDepth(obj: Record<string, any>, currentDepth: number, maxDepth: number): Record<string, any> {
    if (currentDepth >= maxDepth) {
      return { _truncated: true, _depth: currentDepth };
    }

    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.limitDepth(value, currentDepth + 1, maxDepth);
      } else if (Array.isArray(value)) {
        result[key] = this.limitDepthArray(value, currentDepth + 1, maxDepth);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private limitDepthArray(arr: any[], currentDepth: number, maxDepth: number): any {
    if (currentDepth >= maxDepth) {
      return { _truncated: true, _depth: currentDepth, _length: arr.length };
    }

    return arr.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return this.limitDepth(item, currentDepth + 1, maxDepth);
      } else if (Array.isArray(item)) {
        return this.limitDepthArray(item, currentDepth + 1, maxDepth);
      }
      return item;
    });
  }

  // Scan variables for security issues using typed [REDACTED:type] markers.
  // Scans serialized JSON to catch nested PII. Skips entirely when piiScrubbing is false.
  private scanForSecurityIssues(variables: Record<string, any>): {
    variables: Record<string, any>;
    flags: SecurityFlag[];
  } {
    // If PII scrubbing is explicitly disabled, return as-is
    if (this.captureConfig.piiScrubbing === false) {
      return { variables, flags: [] };
    }

    const securityFlags: SecurityFlag[] = [];
    const sanitized = this.sanitizeVariables(variables);

    for (const [name, value] of Object.entries(variables)) {
      // Check variable names for sensitive keywords (word-boundary matching)
      if (SENSITIVE_NAME_PATTERN.test(name)) {
        securityFlags.push({
          type: 'sensitive_variable_name',
          severity: 'medium',
          variable: name,
        });
        sanitized[name] = '[REDACTED:sensitive_name]';
        continue;
      }

      // Serialize value to JSON so nested structures are scanned
      const serialized = this.safeSerialize(value);
      let flagged = false;
      for (const { pattern, marker } of this.piiPatterns) {
        if (pattern.test(serialized)) {
          securityFlags.push({
            type: `sensitive_data_${marker}`,
            severity: 'high',
            variable: name,
          });
          sanitized[name] = marker;
          flagged = true;
          break;
        }
      }
    }

    return {
      variables: sanitized,
      flags: securityFlags,
    };
  }
}
