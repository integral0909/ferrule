/**
 * Enforces the repo-wide configuration convention across every builtin source, operator, and
 * sink: option keys are snake_case (no camelCase, no `Ms`/`_ms` duration-suffix leftovers), and
 * every component carries a non-empty description plus at least one example config that actually
 * validates against its own options schema. This walks `options.toDoc()` recursively — nested
 * object fields, array item schemas, and tagged/plain union variants — so a shared fragment
 * (`batch`, `retry`, `tls`, `auth`, `decoding`/`encoding`, `framing`, ...) is checked everywhere
 * it's used, not just at the top level of one component's options.
 */
import { describe, expect, it } from 'vitest';
import type { SchemaDoc } from '@ferrule/schema';
import { builtinComponents } from '../src/registry.js';

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

interface KeyIssue {
  readonly path: string;
  readonly reason: string;
}

/** Recursively walks a `SchemaDoc` tree, checking every key it finds along the way (object
 * fields, array items, and union/tagged variants) against the naming convention. */
function walkKeys(doc: SchemaDoc, path: string, issues: KeyIssue[]): void {
  if (doc.fields !== undefined) {
    for (const [key, field] of Object.entries(doc.fields)) {
      const fieldPath = path === '' ? key : `${path}.${key}`;
      if (!SNAKE_CASE.test(key)) {
        issues.push({ path: fieldPath, reason: `key ${JSON.stringify(key)} is not snake_case` });
      }
      if (/_ms$/.test(key) || /Ms$/.test(key)) {
        issues.push({ path: fieldPath, reason: `key ${JSON.stringify(key)} ends in _ms/Ms` });
      }
      walkKeys(field, fieldPath, issues);
    }
  }
  if (doc.items !== undefined) walkKeys(doc.items, `${path}[]`, issues);
  if (doc.variants !== undefined) {
    for (const variant of doc.variants) walkKeys(variant, path, issues);
  }
}

describe('builtin component conventions', () => {
  const components = builtinComponents();

  it('registers a substantial set of builtin components', () => {
    // A sanity check that this test is actually exercising the real registry, not an empty one.
    expect(components.length).toBeGreaterThan(20);
  });

  for (const component of components) {
    describe(`${component.kind} "${component.type}"`, () => {
      it('has only snake_case option keys, with no _ms/Ms duration suffix, at every depth', () => {
        const issues: KeyIssue[] = [];
        walkKeys(component.options.toDoc(), '', issues);
        expect(issues).toEqual([]);
      });

      it('has a non-empty description', () => {
        expect(component.description.trim().length).toBeGreaterThan(0);
      });

      it('has at least one example, and every example validates against its own schema', () => {
        const examples = component.examples ?? [];
        expect(examples.length).toBeGreaterThan(0);
        for (const example of examples) {
          const result = component.options.safeParse(example.config);
          if (!result.ok) {
            throw new Error(
              `example ${JSON.stringify(example.title)} for ${component.kind} ` +
                `${JSON.stringify(component.type)} does not validate against its own schema: ` +
                JSON.stringify(result.issues, null, 2),
            );
          }
        }
      });
    });
  }
});
