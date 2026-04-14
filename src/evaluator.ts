/**
 * TraceKit Portable Expression Evaluator for Node.js SDK
 *
 * Implements a sandboxed recursive-descent parser for the portable expression
 * subset defined in EXPRESSION_SPEC.md. Supports comparison, logical, arithmetic
 * operators, dot/bracket property access with null-safe chaining, the "in"
 * membership operator, and literal values (string, number, boolean, nil/null).
 *
 * SECURITY: No eval(), Function(), or arbitrary code execution. Only the
 * operators and constructs listed in the spec are supported.
 */

// ---------------------------------------------------------------------------
// Public error type
// ---------------------------------------------------------------------------

export class UnsupportedExpressionError extends Error {
  constructor(expression: string) {
    super(`Unsupported expression: requires server-side evaluation: ${expression}`);
    this.name = 'UnsupportedExpressionError';
  }
}

// ---------------------------------------------------------------------------
// Classification -- mirrors Go IsSDKEvaluable
// ---------------------------------------------------------------------------

/** Returns true if the expression can be evaluated locally by the SDK. */
export function isSDKEvaluable(expression: string): boolean {
  // Function calls: word followed by opening paren
  if (/\b[a-zA-Z_]\w*\s*\(/.test(expression)) {
    return false;
  }

  // Regex match keyword
  if (/\bmatches\b/.test(expression)) {
    return false;
  }

  // Regex operator =~
  if (expression.includes('=~')) {
    return false;
  }

  // Bitwise NOT ~ (but not inside =~, already handled above)
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === '~' && (i === 0 || expression[i - 1] !== '=')) {
      return false;
    }
  }

  // Bitwise AND: single & not part of &&
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === '&') {
      if (i + 1 < expression.length && expression[i + 1] === '&') {
        i++; // skip &&
        continue;
      }
      return false;
    }
  }

  // Bitwise OR: single | not part of ||
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === '|') {
      if (i + 1 < expression.length && expression[i + 1] === '|') {
        i++; // skip ||
        continue;
      }
      return false;
    }
  }

  // Bit shift
  if (expression.includes('<<') || expression.includes('>>')) {
    return false;
  }

  // Template literals
  if (expression.includes('${')) {
    return false;
  }

  // Range operator
  if (expression.includes('..')) {
    return false;
  }

  // Ternary
  if (expression.includes('?')) {
    return false;
  }

  // Array indexing [N]
  if (/\[\d/.test(expression)) {
    return false;
  }

  // Compound assignment
  if (/[+\-*/]=/.test(expression)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const enum TokenType {
  Number,
  String,
  Identifier,
  Bool,
  Nil,
  Operator,
  LParen,
  RParen,
  LBracket,
  RBracket,
  Dot,
  EOF,
}

interface Token {
  type: TokenType;
  value: string;
  numValue?: number;
  boolValue?: boolean;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Numbers (including negative handled as unary minus via operator)
    if (ch >= '0' && ch <= '9') {
      let num = '';
      while (i < expr.length && ((expr[i] >= '0' && expr[i] <= '9') || expr[i] === '.')) {
        num += expr[i];
        i++;
      }
      const val = num.includes('.') ? parseFloat(num) : parseInt(num, 10);
      tokens.push({ type: TokenType.Number, value: num, numValue: val });
      continue;
    }

    // Strings (double or single quoted)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let str = '';
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\' && i + 1 < expr.length) {
          i++;
          switch (expr[i]) {
            case 'n': str += '\n'; break;
            case 't': str += '\t'; break;
            case '\\': str += '\\'; break;
            default: str += expr[i]; break;
          }
        } else {
          str += expr[i];
        }
        i++;
      }
      i++; // skip closing quote
      tokens.push({ type: TokenType.String, value: str });
      continue;
    }

    // Identifiers and keywords
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let ident = '';
      while (i < expr.length && ((expr[i] >= 'a' && expr[i] <= 'z') || (expr[i] >= 'A' && expr[i] <= 'Z') || (expr[i] >= '0' && expr[i] <= '9') || expr[i] === '_')) {
        ident += expr[i];
        i++;
      }
      if (ident === 'true') {
        tokens.push({ type: TokenType.Bool, value: 'true', boolValue: true });
      } else if (ident === 'false') {
        tokens.push({ type: TokenType.Bool, value: 'false', boolValue: false });
      } else if (ident === 'nil' || ident === 'null') {
        tokens.push({ type: TokenType.Nil, value: 'nil' });
      } else if (ident === 'in') {
        tokens.push({ type: TokenType.Operator, value: 'in' });
      } else {
        tokens.push({ type: TokenType.Identifier, value: ident });
      }
      continue;
    }

    // Two-character operators
    if (i + 1 < expr.length) {
      const two = ch + expr[i + 1];
      if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
        tokens.push({ type: TokenType.Operator, value: two });
        i += 2;
        continue;
      }
    }

    // Single-character operators and punctuation
    if (ch === '!' || ch === '<' || ch === '>' || ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: TokenType.Operator, value: ch });
      i++;
      continue;
    }

    if (ch === '(') { tokens.push({ type: TokenType.LParen, value: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: TokenType.RParen, value: ')' }); i++; continue; }
    if (ch === '[') { tokens.push({ type: TokenType.LBracket, value: '[' }); i++; continue; }
    if (ch === ']') { tokens.push({ type: TokenType.RBracket, value: ']' }); i++; continue; }
    if (ch === '.') { tokens.push({ type: TokenType.Dot, value: '.' }); i++; continue; }

    // Unknown character -- skip
    i++;
  }

  tokens.push({ type: TokenType.EOF, value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Recursive-descent parser
// ---------------------------------------------------------------------------

/** A nil sentinel that is distinct from JS undefined */
const NIL_VALUE = Symbol('nil');

type Value = number | string | boolean | null | typeof NIL_VALUE | Record<string, any>;

class Parser {
  private tokens: Token[];
  private pos: number;
  private env: Record<string, any>;

  constructor(tokens: Token[], env: Record<string, any>) {
    this.tokens = tokens;
    this.pos = 0;
    this.env = env;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }

  private expect(type: TokenType, value?: string): Token {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(`Expected ${value || type} but got ${t.value}`);
    }
    return this.advance();
  }

  // Entry point: parse OR expression (lowest precedence)
  parse(): any {
    const result = this.parseOr();
    return this.unwrap(result);
  }

  // Unwrap NIL_VALUE to null for external consumers
  private unwrap(val: any): any {
    if (val === NIL_VALUE) return null;
    return val;
  }

  // OR: expr || expr
  private parseOr(): any {
    let left = this.parseAnd();
    while (this.peek().type === TokenType.Operator && this.peek().value === '||') {
      this.advance();
      const right = this.parseAnd();
      left = this.toBool(left) || this.toBool(right);
    }
    return left;
  }

  // AND: expr && expr
  private parseAnd(): any {
    let left = this.parseEquality();
    while (this.peek().type === TokenType.Operator && this.peek().value === '&&') {
      this.advance();
      const right = this.parseEquality();
      left = this.toBool(left) && this.toBool(right);
    }
    return left;
  }

  // Equality: expr == expr, expr != expr
  private parseEquality(): any {
    let left = this.parseComparison();
    while (this.peek().type === TokenType.Operator && (this.peek().value === '==' || this.peek().value === '!=')) {
      const op = this.advance().value;
      const right = this.parseComparison();
      if (op === '==') {
        left = this.strictEqual(left, right);
      } else {
        left = !this.strictEqual(left, right);
      }
    }
    return left;
  }

  // Comparison: expr < > <= >= expr
  private parseComparison(): any {
    let left = this.parseIn();
    while (
      this.peek().type === TokenType.Operator &&
      (this.peek().value === '<' || this.peek().value === '>' || this.peek().value === '<=' || this.peek().value === '>=')
    ) {
      const op = this.advance().value;
      const right = this.parseIn();

      // Mixed-type comparisons return false per spec
      const ln = this.normalize(left);
      const rn = this.normalize(right);
      if (ln === null || rn === null || typeof ln !== typeof rn) {
        left = false;
        continue;
      }

      switch (op) {
        case '<':  left = ln < rn; break;
        case '>':  left = ln > rn; break;
        case '<=': left = ln <= rn; break;
        case '>=': left = ln >= rn; break;
      }
    }
    return left;
  }

  // "in" membership: "key" in map
  private parseIn(): any {
    let left = this.parseAddSub();
    while (this.peek().type === TokenType.Operator && this.peek().value === 'in') {
      this.advance();
      const right = this.parseAddSub();
      // "key" in map -- check if key exists
      if (right === null || right === NIL_VALUE || typeof right !== 'object') {
        left = false;
      } else {
        const key = left === NIL_VALUE ? null : left;
        left = typeof key === 'string' && key in (right as Record<string, any>);
      }
    }
    return left;
  }

  // Addition, subtraction, string concatenation
  private parseAddSub(): any {
    let left = this.parseMulDiv();
    while (this.peek().type === TokenType.Operator && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.advance().value;
      const right = this.parseMulDiv();
      const ln = this.normalize(left);
      const rn = this.normalize(right);
      if (op === '+') {
        // String concatenation if either operand is a string
        if (typeof ln === 'string' || typeof rn === 'string') {
          left = String(ln === null ? '' : ln) + String(rn === null ? '' : rn);
        } else if (typeof ln === 'number' && typeof rn === 'number') {
          left = ln + rn;
        } else {
          left = NIL_VALUE;
        }
      } else {
        if (typeof ln === 'number' && typeof rn === 'number') {
          left = ln - rn;
        } else {
          left = NIL_VALUE;
        }
      }
    }
    return left;
  }

  // Multiplication, division
  private parseMulDiv(): any {
    let left = this.parseUnary();
    while (this.peek().type === TokenType.Operator && (this.peek().value === '*' || this.peek().value === '/')) {
      const op = this.advance().value;
      const right = this.parseUnary();
      const ln = this.normalize(left);
      const rn = this.normalize(right);
      if (typeof ln === 'number' && typeof rn === 'number') {
        left = op === '*' ? ln * rn : (rn === 0 ? NIL_VALUE : ln / rn);
      } else {
        left = NIL_VALUE;
      }
    }
    return left;
  }

  // Unary: !, unary -
  private parseUnary(): any {
    if (this.peek().type === TokenType.Operator && this.peek().value === '!') {
      this.advance();
      const val = this.parseUnary();
      return !this.toBool(val);
    }
    if (this.peek().type === TokenType.Operator && this.peek().value === '-') {
      this.advance();
      const val = this.parseUnary();
      const n = this.normalize(val);
      if (typeof n === 'number') return -n;
      return NIL_VALUE;
    }
    return this.parsePostfix();
  }

  // Postfix: property access (dot notation, bracket notation)
  private parsePostfix(): any {
    let left = this.parsePrimary();

    while (true) {
      if (this.peek().type === TokenType.Dot) {
        this.advance();
        const ident = this.expect(TokenType.Identifier);
        left = this.safeAccess(left, ident.value);
      } else if (this.peek().type === TokenType.LBracket) {
        this.advance();
        const key = this.parseOr(); // parse the key expression (no unwrap)
        this.expect(TokenType.RBracket);
        left = this.safeAccess(left, key);
      } else {
        break;
      }
    }

    return left;
  }

  // Primary: literals, identifiers, parenthesized expressions
  private parsePrimary(): any {
    const token = this.peek();

    switch (token.type) {
      case TokenType.Number:
        this.advance();
        return token.numValue!;

      case TokenType.String:
        this.advance();
        return token.value;

      case TokenType.Bool:
        this.advance();
        return token.boolValue!;

      case TokenType.Nil:
        this.advance();
        return NIL_VALUE;

      case TokenType.Identifier: {
        this.advance();
        // Look up in environment
        const val = this.env[token.value];
        if (val === undefined) return NIL_VALUE;
        if (val === null) return NIL_VALUE;
        return val;
      }

      case TokenType.LParen: {
        this.advance();
        const val = this.parseOr();
        this.expect(TokenType.RParen);
        return val;
      }

      default:
        throw new Error(`Unexpected token: ${token.value}`);
    }
  }

  // Null-safe property access
  private safeAccess(obj: any, key: any): any {
    if (obj === null || obj === undefined || obj === NIL_VALUE) {
      return NIL_VALUE;
    }
    if (typeof obj !== 'object') {
      return NIL_VALUE;
    }
    const k = key === NIL_VALUE ? null : key;
    if (typeof k !== 'string' && typeof k !== 'number') {
      return NIL_VALUE;
    }
    const val = (obj as any)[k];
    if (val === undefined) return NIL_VALUE;
    if (val === null) return NIL_VALUE;
    return val;
  }

  // Strict equality per spec: only int-to-float coercion allowed
  private strictEqual(a: any, b: any): boolean {
    const an = this.normalize(a);
    const bn = this.normalize(b);

    // Both null
    if (an === null && bn === null) return true;
    // One null
    if (an === null || bn === null) return false;

    // Both numbers (handles int-to-float coercion)
    if (typeof an === 'number' && typeof bn === 'number') {
      return an === bn;
    }

    // Same type only
    if (typeof an !== typeof bn) return false;

    return an === bn;
  }

  // Normalize internal values for comparison/arithmetic
  private normalize(val: any): any {
    if (val === NIL_VALUE) return null;
    if (val === null || val === undefined) return null;
    return val;
  }

  // Convert to boolean for logical operators
  private toBool(val: any): boolean {
    if (val === NIL_VALUE || val === null || val === undefined) return false;
    if (typeof val === 'boolean') return val;
    // For non-boolean values in boolean context, treat as truthy/falsy
    // but per spec, only booleans should appear in logical contexts
    return !!val;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a condition expression and return a boolean result.
 * Empty expressions return true (no condition = always fire).
 * Throws UnsupportedExpressionError for server-only expressions.
 */
export function evaluateCondition(expression: string, env: Record<string, any>): boolean {
  if (expression === '') {
    return true;
  }

  if (!isSDKEvaluable(expression)) {
    throw new UnsupportedExpressionError(expression);
  }

  const tokens = tokenize(expression);
  const parser = new Parser(tokens, env);
  const result = parser.parse();

  if (typeof result === 'boolean') {
    return result;
  }
  if (result === null) {
    return false;
  }
  // Non-boolean result in condition context is an error per spec,
  // but for robustness treat truthily
  return !!result;
}

/**
 * Evaluate an expression and return the raw result.
 * Unlike evaluateCondition, this does not require a boolean result.
 * Throws UnsupportedExpressionError for server-only expressions.
 */
export function evaluateExpression(expression: string, env: Record<string, any>): any {
  if (expression === '') {
    return null;
  }

  if (!isSDKEvaluable(expression)) {
    throw new UnsupportedExpressionError(expression);
  }

  const tokens = tokenize(expression);
  const parser = new Parser(tokens, env);
  return parser.parse();
}

/**
 * Evaluate multiple expressions against the given environment.
 * Results are keyed by expression string. On error, null is stored.
 */
export function evaluateExpressions(
  expressions: string[],
  env: Record<string, any>
): Record<string, any> {
  const results: Record<string, any> = {};
  for (const expr of expressions) {
    try {
      results[expr] = evaluateExpression(expr, env);
    } catch {
      results[expr] = null;
    }
  }
  return results;
}
