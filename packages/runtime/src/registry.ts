import { FerruleError } from '@ferrule/core';
import { closestMatch } from '@ferrule/schema';
import type {
  ComponentDefinition,
  ComponentKind,
  SinkDefinition,
  SourceDefinition,
  TransformDefinition,
} from './component.js';

/** Raised by component operations that were interrupted because the pipeline is stopping. */
export class ShutdownError extends FerruleError {
  constructor(message = 'pipeline is shutting down') {
    super('E_SHUTDOWN', message);
    this.name = 'ShutdownError';
  }
}

/** Raised when configuration names a component type that is not registered. */
export class UnknownComponentTypeError extends FerruleError {
  constructor(
    readonly kind: ComponentKind,
    readonly componentType: string,
    readonly suggestion: string | undefined,
  ) {
    super(
      'E_UNKNOWN_COMPONENT_TYPE',
      `unknown ${kind} type ${JSON.stringify(componentType)}` +
        (suggestion === undefined ? '' : ` (did you mean ${JSON.stringify(suggestion)}?)`),
    );
    this.name = 'UnknownComponentTypeError';
  }
}

type DefinitionFor<K extends ComponentKind> = K extends 'source'
  ? SourceDefinition
  : K extends 'transform'
    ? TransformDefinition
    : SinkDefinition;

/** The set of component types available to a pipeline. */
export class ComponentRegistry {
  private readonly byKind: { [K in ComponentKind]: Map<string, DefinitionFor<K>> } = {
    source: new Map(),
    transform: new Map(),
    sink: new Map(),
  };

  /** Registers definitions. Registering a type twice for the same kind is an error. */
  register(...definitions: ComponentDefinition[]): this {
    for (const definition of definitions) {
      const map = this.byKind[definition.kind] as Map<string, ComponentDefinition>;
      if (map.has(definition.type)) {
        throw new FerruleError(
          'E_DUPLICATE_COMPONENT_TYPE',
          `${definition.kind} type ${JSON.stringify(definition.type)} is already registered`,
        );
      }
      map.set(definition.type, definition);
    }
    return this;
  }

  has(kind: ComponentKind, type: string): boolean {
    return this.byKind[kind].has(type);
  }

  /** Looks up a definition, throwing {@link UnknownComponentTypeError} with a suggestion if absent. */
  get<K extends ComponentKind>(kind: K, type: string): DefinitionFor<K> {
    const definition = (this.byKind[kind] as Map<string, DefinitionFor<K>>).get(type);
    if (definition === undefined) {
      throw new UnknownComponentTypeError(kind, type, closestMatch(type, this.byKind[kind].keys()));
    }
    return definition;
  }

  /** Definitions of one kind, sorted by type name. */
  list<K extends ComponentKind>(kind: K): DefinitionFor<K>[] {
    return [...(this.byKind[kind] as Map<string, DefinitionFor<K>>).values()].sort((a, b) =>
      a.type.localeCompare(b.type),
    );
  }
}
