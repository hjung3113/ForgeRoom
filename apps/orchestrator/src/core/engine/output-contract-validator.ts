/**
 * OutputContractValidator (ADR-029 E2).
 *
 * Generalizes the hardcoded `## Slices` / `Review Result` rules that previously
 * lived in {@link output-selectors.ts} so the harness owns its output contract.
 * Selectors keep EXTRACTION; this module owns VALIDATION (ADR-029 §3).
 *
 * Throws {@link WorkflowError} with `output_contract_failed` on miss — the same
 * failure code agent-runner's retry budget already drives, so a contract miss
 * surfaces through the existing resume/retry path without new failure kinds.
 */
import { WorkflowError } from '../errors.js';
import type { HarnessOutputContract } from '../agent-runtime/harness-manifest.js';

/**
 * Validate `content` against the harness output contract. Empty/undefined
 * contract = no constraints (early exit). Always validates in this order:
 * 1. min_bytes (cheap) → 2. first_line_regex → 3. required_sections.
 */
export function validateOutputContract(
  content: string,
  contract: HarnessOutputContract | undefined,
): void {
  if (contract === undefined) {
    return;
  }

  if (contract.min_bytes !== undefined) {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes < contract.min_bytes) {
      throw new WorkflowError(
        'output_contract_failed',
        `output is ${bytes} bytes; contract requires at least ${contract.min_bytes}`,
      );
    }
  }

  if (contract.first_line_regex !== undefined) {
    const firstContentLine = firstNonEmptyLine(content);
    if (firstContentLine === null) {
      throw new WorkflowError('output_contract_failed', 'output has no non-empty first line');
    }
    if (!new RegExp(contract.first_line_regex).test(firstContentLine)) {
      throw new WorkflowError(
        'output_contract_failed',
        `output first line does not match ${contract.first_line_regex}`,
      );
    }
  }

  if (contract.required_sections !== undefined) {
    const headings = collectHeadings(content);
    for (const section of contract.required_sections) {
      if (!headings.has(section)) {
        throw new WorkflowError(
          'output_contract_failed',
          `output missing required section: ## ${section}`,
        );
      }
    }
  }
}

function firstNonEmptyLine(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function collectHeadings(content: string): Set<string> {
  const headings = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(\S.*)$/.exec(rawLine.trim());
    if (match !== null) {
      headings.add(match[1]!.trim());
    }
  }
  return headings;
}
