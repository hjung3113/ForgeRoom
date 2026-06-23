# Review Output Contract

You are running a review step ({{step_id}}).

- **Your reply message IS the step output.** ForgeRoom records your reply text
  verbatim as the output — do NOT save, write, or echo it to a file, and do not
  write anything under `.forgeroom/outputs/`. Just answer with the review.
- The first non-empty line of your reply MUST be exactly
  `Review Result: pass` or `Review Result: fail`. This line is the parsed gate.
- After the result line, list your findings.

```markdown
Review Result: fail

## Findings

- ...
```
