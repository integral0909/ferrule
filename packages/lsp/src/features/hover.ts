import { formatExprType, type FunctionRegistry } from '@ferrule/script';
import { findCallNameAt, findTypedExprAt } from '../astUtil.js';
import type { DocumentAnalysis } from '../analysis.js';
import { formatSignatureMarkdown } from '../functionSignatures.js';
import type { Hover, Position } from '../lspTypes.js';
import type { ScopeAnalysis } from '../scopeAnalysis.js';
import { spanToRange } from '../text/positions.js';
import { variableExprType, variableKindLabel } from '../variableInfo.js';

/**
 * `textDocument/hover`: the type of the expression under the cursor (including fallibility, via
 * {@link formatExprType}), a stdlib function's signature/docs/examples when hovering its name, or
 * a `let`-bound variable's binding info (mutability, declaration kind, inferred type).
 */
export function hover(
  analysis: DocumentAnalysis,
  scopeAnalysis: ScopeAnalysis,
  registry: FunctionRegistry,
  position: Position,
): Hover | null {
  const offset = analysis.document.offsetAt(position);
  const source = analysis.document.source;

  const reference = scopeAnalysis.referenceAt(offset);
  const decl = reference?.decl ?? scopeAnalysis.declAt(offset);
  if (decl !== undefined) {
    const exprType = variableExprType(decl, analysis.checkResult, scopeAnalysis);
    const typeText = exprType === undefined ? '' : `: ${formatExprType(exprType)}`;
    const header = `\`\`\`ferrule\n${variableKindLabel(decl.kind)} ${decl.name}${typeText}\n\`\`\``;
    return {
      contents: { kind: 'markdown', value: header },
      range: spanToRange(source, reference?.span ?? decl.nameSpan),
    };
  }

  const call = findCallNameAt(analysis.parseResult.program, offset);
  if (call !== undefined && call.callee.kind === 'identifier') {
    const signature = registry.get(call.callee.name);
    if (signature !== undefined) {
      return {
        contents: formatSignatureMarkdown(signature),
        range: spanToRange(source, call.callee.span),
      };
    }
  }

  const typed = findTypedExprAt(analysis.parseResult.program, offset, analysis.checkResult);
  if (typed !== undefined) {
    const kindLabel =
      typed.expr.kind === 'path'
        ? 'event path'
        : typed.expr.kind === 'metadataPath'
          ? 'metadata path'
          : 'expression';
    const value = `\`\`\`ferrule\n${kindLabel}: ${formatExprType(typed.type)}\n\`\`\``;
    return { contents: { kind: 'markdown', value }, range: spanToRange(source, typed.expr.span) };
  }

  return null;
}
