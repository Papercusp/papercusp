# Autonomous Harness Prompts

Prompts for agents in coding harnesses (the existing top-level files) and department harnesses (the new `base/` + `department/` subtrees).

## Layout

```
prompts/
├── (top-level *.md = coding harness, untouched)
│   architect.md  curator.md  debugger.md  documenter.md
│   orchestrator.md  scoper.md  plan-gate.md  project_manager.md
│   ui-qa.md  validator.md  worker.md  crosscheck.md
│
├── staging/, testing/, production/  — coding phase variants (untouched)
│
├── base/                            — universal base prompts for all roles
│   orchestrator.md  worker.md  validator.md  documenter.md  summarizer.md
│
└── department/                      — department harness flavor
    orchestrator.md  worker.md  validator.md  documenter.md  summarizer.md
    └── departments/
        ├── business/    — orchestrator.md (override) + ceo.md (Directive mode)
        ├── technology/  — orchestrator.md (override)
        ├── rd/          — orchestrator.md (override)
        ├── management/  — orchestrator.md (override)
        └── marketing/   — orchestrator.md (override)
```

## Resolution function (for the runtime to implement)

```
resolve(role, harness_kind, department_slug?, mode?) =
  sections = [read("base/" + role + ".md")]

  if (harness_kind == "coding"):
    sections.push(read(role + ".md"))                                   # top-level
    if (HARNESS_PHASE):
      sections.push_if_exists(read(HARNESS_PHASE + "/" + role + ".md")) # phase variant

  if (harness_kind == "department"):
    sections.push(read("department/" + role + ".md"))
    if (department_slug):
      sections.push_if_exists(read("department/departments/" + department_slug + "/" + role + ".md"))
    if (mode == "ceo" and department_slug == "business" and role == "worker"):
      sections.replace_last_with(read("department/departments/business/ceo.md"))

  return sections.join("\n\n---\n\n")
```

## Triggering CEO mode

Business's orchestrator outputs `NEXT_WORKER_CEO_MODE <MESSAGE_ID>` when the message is a Directive. The runtime:
1. Loads the Directive
2. Resolves the prompt with `mode="ceo"` (which substitutes `business/ceo.md` for the worker layer)
3. Invokes the agent with the resolved prompt and `$MESSAGE_ID` set

For all other Business messages (Proposal, MarketSignal, etc.), the orchestrator outputs the standard `NEXT_WORKER <MESSAGE_ID>` and the worker runs the base department worker prompt.

## Inheritance precedence

Later sections override earlier ones (concatenation; the model treats final sections as most authoritative). Order:
1. `base/<role>.md`             — least specific
2. `<kind>/<role>.md`           — kind-specific
3. `<kind>/departments/<dept>/<role>.md` — dept-specific
4. mode-specific override        — most specific (e.g. ceo.md)
