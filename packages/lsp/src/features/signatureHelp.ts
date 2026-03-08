import type { CallExpr, FunctionRegistry, FunctionSignature } from '@ferrule/script';
import { findEnclosingCall } from '../astUtil.js';
import type { DocumentAnalysis } from '../analysis.js';
import { formatParam, formatSignature, formatSignatureMarkdown } from '../functionSignatures.js';
import type {
  ParameterInformation,
  Position,
  SignatureHelp,
  SignatureInformation,
} from '../lspTypes.js';

/**
 * `textDocument/signatureHelp`: the resolved function's full signature, with the parameter the
 * cursor is currently positioned at (by argument index, or by name for a named argument) marked
 * active. Ferrule Script requires positional arguments before named ones (parser diagnostic E107),
 * so the *n*th positional argument slot always maps to the *n*th non-named-only parameter.
 */
export function signatureHelp(
  analysis: DocumentAnalysis,
  registry: FunctionRegistry,
  position: Position,
): SignatureHelp | null {
  const offset = analysis.document.offsetAt(position);
  const call = findEnclosingCall(analysis.parseResult.program, offset);
  if (call === undefined || call.callee.kind !== 'identifier') return null;
  const resolved = analysis.checkResult.calls.get(call);
  const signature = resolved?.signature ?? registry.get(call.callee.name);
  if (signature === undefined) return null;

  const activeParameter = activeParameterIndex(call, signature, offset);
  const parameters: ParameterInformation[] = signature.params.map((p) => ({
    label: formatParam(p),
    ...(p.doc.length > 0 ? { documentation: { kind: 'markdown' as const, value: p.doc } } : {}),
  }));
  const info: SignatureInformation = {
    label: formatSignature(signature),
    documentation: formatSignatureMarkdown(signature),
    parameters,
    ...(activeParameter === undefined ? {} : { activeParameter }),
  };
  return {
    signatures: [info],
    activeSignature: 0,
    ...(activeParameter === undefined ? {} : { activeParameter }),
  };
}

/** The call-argument slot (0-based) the cursor currently sits in, including an about-to-be-typed one. */
function currentArgIndex(call: CallExpr, offset: number): number {
  for (let i = 0; i < call.args.length; i++) {
    const arg = call.args[i]!;
    if (offset >= arg.span.start && offset <= arg.span.end) return i;
  }
  let count = 0;
  for (const arg of call.args) {
    if (arg.span.end <= offset) count++;
  }
  return count;
}

function activeParameterIndex(
  call: CallExpr,
  signature: FunctionSignature,
  offset: number,
): number | undefined {
  const slot = currentArgIndex(call, offset);
  const argAtSlot = call.args[slot];
  if (argAtSlot?.kind === 'named') {
    const index = signature.params.findIndex((p) => p.name === argAtSlot.name);
    return index === -1 ? undefined : index;
  }
  let positionalCount = 0;
  for (let i = 0; i < slot; i++) {
    if (call.args[i]?.kind === 'positional') positionalCount++;
  }
  const positionalEligible = signature.params.filter((p) => !p.namedOnly);
  const target = positionalEligible[positionalCount];
  if (target === undefined) return undefined;
  return signature.params.indexOf(target);
}
