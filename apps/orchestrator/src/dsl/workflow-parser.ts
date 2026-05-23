import { isMap, isScalar, isSeq, parseDocument, type Node, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';

import { WorkflowParseError } from './dsl-errors.js';
import type {
  ParsedWorkflowConfig,
  SourceLocation,
  WorkflowDiagnosticContext,
  WorkflowParseOptions,
  WorkflowSourceMap,
} from './types.js';

export function parseWorkflowConfig(source: string, options: WorkflowParseOptions = {}): ParsedWorkflowConfig {
  const sourceLabel = options.source ?? '<inline>';
  const locate = buildLineCounter(source);
  const document = parseDocument(source, {
    keepSourceTokens: true,
    prettyErrors: false,
  });
  const firstError = document.errors[0];
  if (firstError !== undefined) {
    throw new WorkflowParseError('Failed to parse workflow yaml', errorLocation(firstError, locate), sourceLabel);
  }
  if (!isMap(document.contents)) {
    throw new WorkflowParseError('Workflow yaml must be a top-level mapping', null, sourceLabel);
  }

  const config = document.toJS() as Record<string, Record<string, unknown>>;
  const sourceMap = buildWorkflowSourceMap(document.contents, locate, sourceLabel);

  return { config, sourceMap };
}

export function workflowSourceContext(
  sourceMap: WorkflowSourceMap,
  workflowId: string,
  field: string,
): WorkflowDiagnosticContext {
  const workflow = sourceMap.workflows[workflowId];

  return {
    source: sourceMap.source,
    workflowId,
    field,
    location: workflow?.fields[field] ?? workflow?.id ?? null,
  };
}

function buildWorkflowSourceMap(
  root: YAMLMap,
  locate: OffsetLocator,
  source: string,
): WorkflowSourceMap {
  const workflows: WorkflowSourceMap['workflows'] = {};

  for (const item of root.items) {
    const workflowId = scalarString(item.key);
    if (workflowId === null) {
      continue;
    }
    workflows[workflowId] = {
      id: nodeLocation(item.key, locate) ?? { line: 1, column: 1 },
      fields: {},
    };

    if (isMap(item.value)) {
      collectFieldLocations(item.value, '', workflows[workflowId].fields, locate);
    }
  }

  return { source, workflows };
}

function collectFieldLocations(
  node: YAMLMap | YAMLSeq,
  prefix: string,
  fields: Record<string, SourceLocation>,
  locate: OffsetLocator,
): void {
  if (isMap(node)) {
    for (const item of node.items) {
      const key = scalarString(item.key);
      if (key === null) {
        continue;
      }
      const path = prefix === '' ? key : `${prefix}.${key}`;
      const location = nodeLocation(item.value, locate) ?? nodeLocation(item.key, locate);
      if (location !== null) {
        fields[path] = location;
      }
      collectNestedFieldLocations(item.value, path, fields, locate);
    }
    return;
  }

  node.items.forEach((item, index) => {
    const path = `${prefix}[${String(index)}]`;
    const location = nodeLocation(item, locate);
    if (location !== null) {
      fields[path] = location;
    }
    collectNestedFieldLocations(item, path, fields, locate);
  });
}

function collectNestedFieldLocations(
  value: Pair['value'],
  path: string,
  fields: Record<string, SourceLocation>,
  locate: OffsetLocator,
): void {
  if (isMap(value) || isSeq(value)) {
    collectFieldLocations(value, path, fields, locate);
  }
}

function scalarString(value: Pair['key']): string | null {
  if (!isScalar(value)) {
    return null;
  }
  return typeof value.value === 'string' ? value.value : String(value.value);
}

function nodeLocation(value: unknown, locate: OffsetLocator): SourceLocation | null {
  if (!isNodeWithRange(value) || value.range === undefined || value.range === null) {
    return null;
  }

  return locate(value.range[0]);
}

interface NodeWithRange {
  range?: [number, number, number] | null;
}

function isNodeWithRange(value: unknown): value is Node & NodeWithRange {
  return typeof value === 'object' && value !== null && 'range' in value;
}

type OffsetLocator = (offset: number) => SourceLocation;

function buildLineCounter(source: string): OffsetLocator {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return (offset: number): SourceLocation => {
    let lineIndex = 0;
    for (let index = 0; index < lineStarts.length; index += 1) {
      const lineStart = lineStarts[index];
      if (lineStart === undefined || lineStart > offset) {
        break;
      }
      lineIndex = index;
    }

    return {
      line: lineIndex + 1,
      column: offset - (lineStarts[lineIndex] ?? 0) + 1,
    };
  };
}

interface YamlErrorWithLocation {
  linePos?: Array<{ line: number; col: number }>;
  pos?: [number, number];
}

function errorLocation(error: unknown, locate: OffsetLocator): SourceLocation | null {
  const yamlError = error as YamlErrorWithLocation;
  const firstPosition = yamlError.linePos?.[0];
  if (firstPosition === undefined) {
    const offset = yamlError.pos?.[0];
    return offset === undefined ? null : locate(offset);
  }

  return {
    line: firstPosition.line,
    column: firstPosition.col,
  };
}
