import * as fs from 'fs';
import * as path from 'path';
import {
  isSDKEvaluable,
  evaluateCondition,
  evaluateExpression,
  evaluateExpressions,
  UnsupportedExpressionError,
} from '../src/evaluator';

// Load shared test fixtures
const fixturesPath = path.join(__dirname, '..', 'testdata', 'expression_fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf-8'));
const defaultVars = fixtures.default_variables;

interface TestCase {
  id: string;
  category: string;
  description: string;
  expression: string;
  variables: Record<string, any> | null;
  expected: any;
  classify: 'sdk-evaluable' | 'server-only';
}

const testCases: TestCase[] = fixtures.test_cases;

describe('Expression Evaluator', () => {
  describe('isSDKEvaluable', () => {
    test('returns true for simple comparison', () => {
      expect(isSDKEvaluable('status == 200')).toBe(true);
    });

    test('returns false for function call', () => {
      expect(isSDKEvaluable("matches(path, '/api')")).toBe(false);
    });

    test('returns false for regex operator', () => {
      expect(isSDKEvaluable("path =~ '/api'")).toBe(false);
    });
  });

  describe('evaluateCondition', () => {
    test('returns true for empty expression', () => {
      expect(evaluateCondition('', defaultVars)).toBe(true);
    });

    test('throws UnsupportedExpressionError for server-only expression', () => {
      expect(() => evaluateCondition("len(user.profile.tags) > 1", defaultVars))
        .toThrow(UnsupportedExpressionError);
    });

    test('returns true when property equals nil', () => {
      expect(evaluateCondition('user.nonexistent == nil', defaultVars)).toBe(true);
    });
  });

  describe('evaluateExpression', () => {
    test('returns numeric result', () => {
      expect(evaluateExpression('status + 100', defaultVars)).toBe(300);
    });
  });

  describe('evaluateExpressions', () => {
    test('returns map of results', () => {
      const result = evaluateExpressions(['status', 'method'], defaultVars);
      expect(result).toEqual({ status: 200, method: 'GET' });
    });
  });

  // Run all 64 fixture test cases
  describe('Shared fixture test cases', () => {
    for (const tc of testCases) {
      const env = tc.variables || defaultVars;

      if (tc.classify === 'server-only') {
        test(`[${tc.id}] ${tc.description} - classified as server-only`, () => {
          expect(isSDKEvaluable(tc.expression)).toBe(false);
        });
      } else if (typeof tc.expected === 'boolean') {
        test(`[${tc.id}] ${tc.description} - condition returns ${tc.expected}`, () => {
          expect(evaluateCondition(tc.expression, env)).toBe(tc.expected);
        });
      } else if (typeof tc.expected === 'number') {
        test(`[${tc.id}] ${tc.description} - expression returns ${tc.expected}`, () => {
          expect(evaluateExpression(tc.expression, env)).toBe(tc.expected);
        });
      } else if (typeof tc.expected === 'string') {
        test(`[${tc.id}] ${tc.description} - expression returns "${tc.expected}"`, () => {
          expect(evaluateExpression(tc.expression, env)).toBe(tc.expected);
        });
      } else if (tc.expected === null) {
        test(`[${tc.id}] ${tc.description} - expression returns null`, () => {
          expect(evaluateExpression(tc.expression, env)).toBeNull();
        });
      }
    }
  });
});
