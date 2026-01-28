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

export class SnapshotClient {
  private apiKey: string;
  private baseURL: string;
  private serviceName: string;
  private breakpointsCache: Map<string, BreakpointConfig> = new Map();
  private registrationCache: Set<string> = new Set();
  private pollInterval?: NodeJS.Timeout;
  private lastFetch?: Date;

  constructor(apiKey: string, baseURL: string, serviceName: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.serviceName = serviceName;
  }

  // Start background polling
  start(): void {
    this.fetchActiveBreakpoints(); // Immediate fetch
    this.pollInterval = setInterval(
      () => this.fetchActiveBreakpoints(),
      30000 // 30 seconds
    );
    console.log(`📸 TraceKit Snapshot Client started for service: ${this.serviceName}`);
  }

  // Stop polling
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    console.log('📸 TraceKit Snapshot Client stopped');
  }

  // Automatic capture with runtime detection
  async checkAndCaptureWithContext(
    label: string,
    variables: Record<string, any> = {}
  ): Promise<void> {
    // Get caller information using Error stack trace
    const stack = new Error().stack || '';
    const caller = this.parseStackTrace(stack);

    if (!caller) {
      console.warn('⚠️  Could not detect caller location');
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

    // Extract request context (from AsyncLocalStorage or global)
    const requestContext = this.extractRequestContext();

    // Scan variables for security issues
    const securityScan = this.scanForSecurityIssues(variables);

    // Create snapshot
    const snapshot: Snapshot = {
      breakpoint_id: breakpoint.id,
      service_name: this.serviceName,
      file_path: file,
      function_name: functionName,
      label,
      line_number: line,
      variables: securityScan.variables,
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

  // Fetch active breakpoints from backend
  private async fetchActiveBreakpoints(): Promise<void> {
    try {
      const url = `${this.baseURL}/sdk/snapshots/active/${this.serviceName}`;
      const response = await fetch(url, {
        headers: {
          'X-API-Key': this.apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as { breakpoints?: BreakpointConfig[] };
      this.updateBreakpointCache(data.breakpoints || []);
      this.lastFetch = new Date();
    } catch (error) {
      console.error('⚠️  Failed to fetch breakpoints:', error);
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

  // Capture and send snapshot
  private async captureSnapshot(snapshot: Snapshot): Promise<void> {
    try {
      const response = await fetch(`${this.baseURL}/sdk/snapshots/capture`, {
        method: 'POST',
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(snapshot),
      });

      if (!response.ok) {
        console.error('⚠️  Failed to capture snapshot:', response.status);
      } else {
        console.log(`📸 Snapshot captured: ${snapshot.label || snapshot.file_path}`);
      }
    } catch (error) {
      console.error('⚠️  Failed to capture snapshot:', error);
    }
  }

  // Extract request context from AsyncLocalStorage or global
  private extractRequestContext(): Record<string, any> | undefined {
    return getRequestContext();
  }

  // Sanitize variables for JSON serialization
  private sanitizeVariables(variables: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(variables)) {
      try {
        JSON.stringify(value); // Test if serializable
        sanitized[key] = value;
      } catch {
        sanitized[key] = `[${typeof value}]`;
      }
    }

    return sanitized;
  }

  // Scan variables for security issues (passwords, API keys, etc.)
  private scanForSecurityIssues(variables: Record<string, any>): {
    variables: Record<string, any>;
    flags: SecurityFlag[];
  } {
    const sensitivePatterns: Record<string, RegExp> = {
      password: /(?:password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{6,}/i,
      api_key: /(?:api[_-]?key|apikey)\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}/i,
      jwt: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/,
      credit_card: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14})\b/,
    };

    const securityFlags: SecurityFlag[] = [];
    const sanitized = this.sanitizeVariables(variables);

    // Scan variable names and values
    for (const [name, value] of Object.entries(variables)) {
      // Check variable names for sensitive patterns
      if (/password|secret|token|key|credential/i.test(name)) {
        securityFlags.push({
          type: 'sensitive_variable_name',
          severity: 'medium',
          variable: name,
        });
        sanitized[name] = '[REDACTED]';
        continue;
      }

      // Check variable values for sensitive data
      const serialized = JSON.stringify(value);
      for (const [type, pattern] of Object.entries(sensitivePatterns)) {
        if (pattern.test(serialized)) {
          securityFlags.push({
            type: `sensitive_data_${type}`,
            severity: 'high',
            variable: name,
          });
          sanitized[name] = '[REDACTED]';
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
