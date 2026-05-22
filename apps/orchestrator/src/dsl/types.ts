export interface SourceLocation {
  line: number;
  column: number;
}

export interface WorkflowParseOptions {
  source?: string;
}

export interface WorkflowDiagnosticContext {
  source: string;
  workflowId: string;
  field?: string;
  location: SourceLocation | null;
}

export interface WorkflowSourceMetadata {
  id: SourceLocation;
  fields: Record<string, SourceLocation>;
}

export interface WorkflowSourceMap {
  source: string;
  workflows: Record<string, WorkflowSourceMetadata>;
}

export interface ParsedWorkflowConfig {
  config: Record<string, Record<string, unknown>>;
  sourceMap: WorkflowSourceMap;
}

export type WorkflowExpressionErrorCode =
  | 'missing-variable'
  | 'unsupported-expression'
  | 'unsupported-value';
