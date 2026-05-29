# Planning Output Contract

You are running a planning/refine step ({{step_id}}).

- Write your full response to the output file referenced by the run message.
- The response MUST end with a `## Slices` section. Under it, list each
  implementation slice as a single top-level `- ` bullet on its own line.
  Nested bullets are ignored. This section is the source of the task slices.

```markdown
## Slices

- First implementation slice as one line
- Second implementation slice as one line
```
