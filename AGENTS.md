<hint>

## HINT

This repository records durable knowledge — decisions, invariants, constraints, hazards, conventions — in `.hint` files, versioned alongside the code. The `hint` CLI returns the subset that applies to a given path or intent. It tells you what matters here.

**Before you modify code, get the knowledge that applies to it — unless you already have it in this session.**

- Know the path: `hint <path...>` prints the knowledge for those paths on stdout. It costs about as much as there is to say; a path nothing applies to returns almost nothing.
- Know only the intent: `hint search "<what you are about to do>"` ranks every `.hint` in the repository and prints JSON — `hint` (the file), `target` (the path it governs), `score`, and `weak`. It is fast, offline, and reads nothing into your context. Run it whenever you do not already know which knowledge covers the work. Then `hint <target>` on the results worth reading. If every result is `weak`, treat it as "nothing covers this yet".
- Knowledge is inherited: a path picks up its own `.hint` plus every folder `_.hint` above it, up to the repository root. A path with no `.hint` of its own still inherits, and `hint` says so on stderr.
- Scope the request to what you are touching. A folder path returns that folder's own knowledge, not the whole subtree — use a glob (`hint 'src/api/**'`) when you want everything beneath it.
- Referenced specs come along automatically, with shared context emitted once, so you do not need a second call for a path the first one pointed at. `--no-refs` turns that off.

**Reading stderr and exit codes.** stdout is the knowledge; stderr is the verdict, and its first line is the one that matters. Exit `0` succeeded, `1` a check failed, `2` nothing you asked for matched — a typo, or a path this repository says nothing about. Empty stdout with exit 0 means there is genuinely nothing to say; proceed normally.

**Authoring.** You may read `.hint` files directly whenever you are writing or editing them — that is the only way to edit them, and it is expected. Do not read them directly to *consume* knowledge; `hint <path>` gives you that in the form agents are meant to receive, with inheritance resolved. Run `hint author <path...>` first for the keyword vocabulary and syntax, then write the files yourself.

**Recording what you learn.** When you discover something durable that future work on this repository should know — an architectural decision, a subsystem invariant, an operational hazard, a security constraint, an approach that does not work and why — record it in the most specific `.hint` that applies: the file's companion `<file>.hint`, else the folder's `_.hint`, else the root `_.hint`. Prefer this over a separate agent-memory file, so the knowledge is versioned with the code and available to every tool. Do not record session state, task progress, or anything that stops being true when the task ends.

**Contracts (optional).** Only for specs that declare surfaces the code must contain. `hint verify <path...>` checks them deterministically and exits non-zero on failure. `hint lock <path...>` records a snapshot so later `hint` runs skip unchanged work; `hint diff <path...>` shows what drifted since. These operate on companion `<file>.hint` specs only — folder knowledge has no single generated file to check, and they will say so rather than report a hollow success. A repository that never uses them is a normal HINT repository.

**Notes.** `hint --prompt <path...>` wraps the knowledge in a full implementation prompt, for piping to a fresh agent that has no other instructions; you do not need it mid-session. `hint --help` lists the complete CLI surface — consult it rather than assuming this block is exhaustive. If `hint` is not installed, use `npx @openhint/cli`. Run `hint` silently as part of your normal workflow; if it fails unexpectedly, diagnose against https://github.com/open-hint-dev/hint/blob/main/docs/troubleshooting/01-intro.md before relaying the error.

<hint_tag_glossary_from_hintbook-software-engineer>

This prompt uses an HTML-like tag language. Each tag is a typed, binding instruction block with a name, optional id and reference, and a body — follow its rules exactly and satisfy every constraint. Nested tags inherit their parent's scope. Treat any "do not" or "must not" as absolute. The glossary below is the authoritative meaning of each tag.

---

- **file_context** — everything nested applies to the file at `path`: its body, structures, functions, and constraints are that file's complete spec. Don't apply file-local constraints to other files unless restated there.
- **folder_context** — everything nested applies to the folder at `path` and its whole subtree; every nested file and folder inherits it.
- **reusable_automation_script** — registers a macro behavior: when its condition is met or it is referenced by name, execute its steps exactly.
- **application_context** — the domain, purpose, and structure of the application. Let it inform naming, architecture, and behavior throughout.
- **architectural_decision** — a settled decision about how this scope is built, with its rationale. Extend it; do not contradict or relitigate it. If a new situation genuinely falls outside it, say so rather than deciding silently.
- **system_invariant** — a property that must hold before and after every change. Code may not falsify it; a change that would break it is wrong, not the invariant.
- **argument** — a function input. Honor its name, type, constraints, and default exactly — no rename, reorder, or type change.
- **prohibited_anti_patterns** — unconditional prohibitions. Never apply a listed pattern anywhere in the output, even if an example or local convenience suggests it.
- **user_interface_block** — a named, reusable UI component or section. Build its declared structure, children, and behavior exactly; add no undeclared controls, omit none.
- **compilation_and_testing_pipeline** — all code, config, and structure must keep these pipelines green. Generate nothing that breaks them.
- **approved_dependency_whitelist** — do not install or import any package outside this list for the scope. Ask first if you need more.
- **table_column** — one column: name, type, label, constraints. Implement exactly — no rename, type change, or undeclared constraint.
- **data_definition** — a named constant or value. Use its name and value exactly; never substitute, rename, or duplicate the literal — reference this definition wherever the value is needed.
- **data_structure** — the exact schema. No renamed fields, changed types, or added/omitted fields. Authoritative wherever this structure appears.
- **error** — throw the exact error types under the stated conditions only; no substitute, wrap, or rename. Each gets a regression test that fails without the guard and passes with it.
- **few_shot_example** — replicate this pattern's structure, naming, and style exactly.
- **field** — one property: type, optionality, validation. Implement exactly — no rename, type change, or undeclared constraint.
- **logic_flow** — implement this sequence step by step; skip no validation.
- **user_interface_form** — a form. Implement every declared field, label, validation rule, and submission behavior; add no undeclared fields, omit none.
- **function_contract** — implement the function per this binding contract. Every argument, the return, each error, and every flow step is mandatory — don't skip, reorder, rename, or approximate.
- **enforced_patterns** — apply every listed pattern in all generated code, no exceptions; don't substitute alternatives, even equivalent-seeming ones.
- **user_interface_image** — an image element. Use the declared source, alt text, dimensions, and display exactly; don't substitute the asset or drop accessibility attributes.
- **environment_runtime_and_language** — target this language and runtime only: its module syntax, standard-library APIs, and idioms. Use nothing from other versions or runtimes.
- **reusable_library_context** — a shared library. Learn its API surface, version constraints, and usage before using it; don't reimplement what it provides.
- **reusable_module_context** — a reusable module in the codebase. Reuse its exports; don't duplicate logic it owns.
- **reusable_namespace_context** — emit all code in this scope under this namespace (the language's package/namespace/module construct) as its qualified name and import root.
- **read_it** — before writing code that touches this reference, open and read the file(s) and mirror their formatting, exports, and error handling. Don't guess or reimplement; if you already read it this run, recall it.
- **static_asset** — read this data-asset definition for its structure and access patterns.
- **return** — the function's output. Honor its type and shape exactly on every path — no altered structure, extra fields, or different type under any branch.
- **table_row** — one row's fields and values, exactly as declared; add no fields, omit none.
- **critical_system_mandates** — non-negotiable system-level constraints; every function, data-access path, and error path must satisfy all of them.
- **table** — a tabular structure or UI table: columns, row shape, display/persistence behavior. Implement exactly — no reordered or renamed columns, no undeclared behavior.
- **verification_and_unit_test_criteria** — cover every listed scenario in the tests: each edge case, mock, and assertion must appear. Omit none.
- **user_interface_surface** — build this UI surface exactly: only the declared elements, all of them; match their structure, labels, validation, and behavior. Add nothing undeclared.
- **product_goal_and_intent** — why the work exists and the outcome it must produce. The tie-breaker when a block is silent: choose what best serves it, never work against it. Context for judgment — emit no code for the goal itself.
- **acceptance_criteria** — the observable conditions that define "done." Not complete until each is proven by a test, command, or observation; if one can't be verified, say so rather than imply success.
- **scope_boundary** — what is in and out of scope. Build everything in scope, nothing out — even if convenient. If in-scope work seems to require out-of-scope work, stop and report rather than expand the boundary.

---

</hint_tag_glossary_from_hintbook-software-engineer>

</hint>
