# AMS contribution-signal inventory — what real repos actually expose as eligibility signals

Research spike for **#6794**, grounding the `ContributionProfile` schema design (#6795) in an audit of real
repos rather than an assumption about what repos "usually" do. Every number below was read from the live
GitHub REST API (`GET /repos/{owner}/{repo}/labels`, `GET /repos/{owner}/{repo}/contents/{path}`) against the
sample on 2026-07-17. **Research and writeup only — no code, no schema, no `discover` wiring here.**

## Summary

**Three findings should shape the schema, and all three argue for treating extraction as best-effort and
per-signal rather than as a reliable parse:**

1. **There is no universal eligibility label.** `good first issue` / `help wanted` exist in only **6 of 10**
   sampled repos. The three largest (rust, deno, kubernetes) use their own taxonomies entirely — rust's is
   `E-easy` / `E-medium` / `E-hard` / `E-help-wanted`. A profile that name-matches a fixed list silently
   returns "no eligible issues" on exactly the repos with the most contributor activity.
2. **Label _descriptions_ are unreliable, and unreliable unevenly.** Coverage ranges from **3/17** (tailwind)
   and **8/76** (react) to **99/100** (rust). So a schema cannot depend on the description carrying the
   semantics — but it also must not ignore it, because on some repos the description is the _only_ place the
   semantics live (rust's `E-easy` description literally reads "…Good first issue.", which name-matching alone
   would miss).
3. **`CONTRIBUTING.md` is frequently a signpost, not the rules.** react's is **208 bytes** and kubernetes' is
   **525 bytes** — both mostly a link to an external contributor guide. "Has CONTRIBUTING.md" is therefore a
   near-worthless presence check; size and content matter, and the real rules often live off-repo where AMS
   cannot read them.

**A fourth finding is worth stating because it cuts against our own intuition:** the _linked-issue requirement_
— the rule loopover's own gate enforces hardest — is **not a general convention**. Grepping the real
`CONTRIBUTING.md` of each repo for linked-issue language: loopover **8** mentions, react **0**, rust **0**,
kubernetes **0**. Building the profile around "does a PR need a closing-keyword issue reference" would encode
loopover's local norm as if it were an ecosystem norm.

## The sample

Ten repos: two of JSONbored's own gate-enabled repos, six well-known OSS projects with deliberately different
contribution norms, one repo with AI-agent docs but no human contribution docs, and one with no contribution
docs at all (the negative case #6794 asks for).

| Repo                       | Labels | Described | `CONTRIBUTING`     | PR template | AI-agent docs            |
| -------------------------- | -----: | --------: | ------------------ | ----------- | ------------------------ |
| `JSONbored/loopover`       |     27 |        25 | ✅ 19,926 B        | —           | `AGENTS.md`, `CLAUDE.md` |
| `JSONbored/metagraphed`    |     27 |        21 | ✅                 | —           | `AGENTS.md`, `CLAUDE.md` |
| `facebook/react`           |     76 |         8 | ⚠️ 208 B (pointer) | ✅          | `CLAUDE.md`              |
| `rust-lang/rust`           |   100+ |        99 | ✅ 2,712 B         | —           | —                        |
| `sveltejs/svelte`          |     36 |        12 | ✅ 10,278 B        | ✅          | `AGENTS.md`              |
| `denoland/deno`            |   100+ |        67 | ✅ `.github/`      | ✅          | `CLAUDE.md`              |
| `tailwindlabs/tailwindcss` |     17 |         3 | ✅ `.github/`      | ✅          | —                        |
| `kubernetes/kubernetes`    |   100+ |        36 | ⚠️ 525 B (pointer) | ✅          | `AGENTS.md`              |
| `JSONbored/sure-aio`       |     16 |        13 | —                  | —           | `AGENTS.md`              |
| `sindresorhus/slugify`     |      8 |         8 | —                  | —           | —                        |

`CONTRIBUTING` lives at the repo root in 6/10 and under `.github/` in 2/10, so extraction must probe both.

## Signal type 1 — eligibility labels

| Repo                       | Conventional eligibility label present? |
| -------------------------- | --------------------------------------- |
| loopover, metagraphed      | `help wanted` only                      |
| react, tailwindcss         | `good first issue` only                 |
| svelte, slugify, sure-aio  | both                                    |
| **rust, deno, kubernetes** | **neither**                             |

rust's actual taxonomy, with the semantics in the description rather than the name:

```
E-easy         :: Call for participation: Easy difficulty. Experience needed to fix: Not much. Good first issue.
E-help-wanted  :: Call for participation: Help is requested to fix this issue.
E-medium       :: Call for participation: Medium difficulty. Experience needed to fix: Intermediate.
E-hard         :: Call for participation: Hard difficulty. Experience needed to fix: A lot.
```

**Implication for the schema:** eligibility-label rules need to be a _list of matchers over name **and**
description_, not a fixed name list — and the profile must be able to say "this repo exposes no eligibility
label at all", which is the honest answer for 3/10 of the sample and is different from "we failed to look".

loopover's own `gittensor:*` labels are the far end of the spectrum: every one carries an explicit,
machine-readable eligibility statement in its description. That is a **local convention**, not a shape to
generalize from — it exists because loopover authored its own labels for its own gate.

## Signal type 2 — exclusion / maintainer-only labels

Nothing in the sample marks issues maintainer-only via a label whose _name_ says so. The closest generic
signals are status labels (`blocked`, `needs-triage`, `on-hold`) whose exclusion meaning is conventional, not
stated. react's `good first issue (taken)` is the one explicit "no longer available" marker found — and it
encodes availability in the **name suffix**, which no other repo in the sample does.

**Implication:** exclusion rules will be weaker and more inferential than eligibility rules; the confidence
indicator #6795 calls for matters most here.

## Signal type 3 — assignee rules

Only loopover's `CONTRIBUTING.md` mentions assignment at all (1 mention); rust and kubernetes: 0. kubernetes
does use `/assign` heavily, but that lives in its **external** community guide, not in-repo.

**Implication:** "not assigned to the repo owner" cannot be sourced from docs for most repos. It is derivable
from the issue's own `assignees` field at query time, which is a _runtime_ check, not a profile rule — worth
separating in the schema.

## Signal type 4 — PR templates and linked-issue requirements

PR templates exist in 6/10, but presence says little: they are largely checklists of prose ("I have read the
contributing guide"), not machine-checkable eligibility gates. As noted in the Summary, the closing-keyword
linked-issue requirement is loopover-specific (8 vs 0 vs 0 vs 0).

## Signal type 5 — AI-agent-facing docs (the surprise)

**6 of 10 carry `AGENTS.md` and/or `CLAUDE.md`** — including react, deno, kubernetes and svelte. This is the
most _consistently present_ signal in the sample after labels themselves, and it did not exist as a convention
two years ago.

`JSONbored/sure-aio` is the sharpest data point: **`AGENTS.md` and no `CONTRIBUTING.md`** — a repo that
documents its rules for an AI contributor and not for a human one. Any extraction that treats `CONTRIBUTING.md`
as the primary source and agent docs as a fallback has the priority backwards for that repo.

## The negative case

`sindresorhus/slugify`: no `CONTRIBUTING`, no PR template, no agent docs, 8 labels — all described, but only
`good first issue` / `help wanted` carry eligibility meaning. `sindresorhus/p-map` (7 labels) and `chalk/chalk`
(10 labels) match. This is a real and common shape: **labels are the only signal**, and the profile must
degrade to "eligibility from labels alone, low completeness" rather than fail.

## What this means for #6795

- **Per-signal provenance and confidence are load-bearing, not nice-to-have.** The sample's signal quality
  varies so widely between repos that a single repo-level confidence score would be useless — `rust` has
  excellent label descriptions and no PR template; `react` has a PR template and almost no label descriptions.
- **Every rule must be independently absent.** 3/10 have no eligibility label; 2/10 have no docs at all; 4/10
  have no agent docs. "Absent" needs to be a first-class value, distinct from "not yet extracted".
- **Do not model the linked-issue rule as a core field.** It is loopover's norm, absent from the rest of the
  sample.
- **Probe both `CONTRIBUTING.md` and `.github/CONTRIBUTING.md`,** and treat a very small file as a pointer
  rather than as rules.
- **Rank agent docs at least as highly as `CONTRIBUTING.md`** as a rule source.

## Method / reproducibility

Every figure came from the live API; nothing was inferred from memory. Label counts are `length` over
`GET /repos/{owner}/{repo}/labels?per_page=100` (paginated for the 100+ repos); "Described" counts labels whose
`description` is non-null and non-empty; doc presence is a `GET .../contents/{path}` probe (404 ⇒ absent); file
sizes are the contents API's own `size`; the linked-issue and assignment figures are case-insensitive greps of
each decoded `CONTRIBUTING.md`. Counts are a point-in-time snapshot and will drift as these repos evolve — the
_shape_ of the finding (wide, uneven variance) is the durable part, not the exact integers.
