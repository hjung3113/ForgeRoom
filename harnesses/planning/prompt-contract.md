# Planning Output Contract

You are running a planning/refine step ({{step_id}}).

- **Your reply message IS the step output.** ForgeRoom records your reply text
  verbatim as the output — do NOT save, write, or echo it to a file, and do not
  write anything under `.forgeroom/outputs/`. Just answer with the plan.
- Your reply MUST end with a `## Slices` section. Under it, list each
  implementation slice as a single top-level `- ` bullet on its own line.
  Nested bullets are ignored. This section is the source of the task slices.

```markdown
## Slices

- First implementation slice as one line
- Second implementation slice as one line
```
