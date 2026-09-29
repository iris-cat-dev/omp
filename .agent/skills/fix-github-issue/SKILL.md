---
name: fix-github-issue
description: >-
  Diagnose and resolve one GitHub issue end to end: read the complete issue and
  discussion, inspect the repository, reproduce or encode the failure, implement
  the root-cause fix, verify the changed behavior, commit and push the scoped
  changes, then post evidence and close the issue. Use when the user supplies a
  GitHub issue URL or number and explicitly wants the fix delivered and the issue
  closed.
---

# Fix GitHub Issue

Deliver one issue completely. “Done” means the fix is implemented and exercised, its scoped commit is visible on the target GitHub repository, the issue contains a comment linking that commit and listing verification, and the issue is observed in the closed state.

## Inputs

Use the issue URL or number from the user’s request. If only a number is supplied, derive `owner/repo` from the current checkout’s `origin`. Reject an issue belonging to a different repository unless the current checkout is demonstrably that issue’s codebase.

The skill invocation authorizes the ordinary end-to-end operations named above. It does **not** authorize force-pushes, bypassing branch protection, discarding local changes, merging an unrelated branch, weakening tests, or closing an issue whose fix is not delivered.

## Procedure

### 1. Establish repository and issue identity

1. Resolve the repository root, current branch, `origin`, default branch, and working-tree state.
2. Preserve all pre-existing work. Never reset, clean, stash, amend, or stage unrelated files. If unrelated changes overlap files required by the fix and cannot be separated safely, stop with the exact conflict.
3. Read the issue body and every comment. Prefer `issue://<number>` or `issue://<owner>/<repo>/<number>`; if unavailable, read the canonical GitHub URL or use the browser/API. Record:
   - exact expected and actual behavior;
   - environment and reproduction details;
   - acceptance criteria;
   - maintainer decisions in comments;
   - linked issues, commits, and pull requests.
4. Confirm the issue is open. Search open and merged pull requests plus recent commits for the issue number and distinctive title terms. Do not create a competing fix. If an existing change already resolves it, verify that change and report the existing delivery path instead.

### 2. Diagnose from evidence

1. Read repository instructions (`AGENTS.md`, package-specific guidance, test commands) and the relevant implementation before editing.
2. Trace the affected behavior end to end, including security boundaries, persistence, localization, protocol contracts, and every production callsite that can reach it.
3. State a concrete failure hypothesis backed by source evidence.
4. Reproduce the bug before fixing it when the environment supports the affected surface. Prefer the real UI/CLI/API path. Add a focused temporary or permanent regression test when it can represent the consumer-visible failure.
5. Treat user-reported output and observations as authoritative. Do not rerun the exact reported command merely to challenge the report; use a focused scenario to locate the cause and prove the fix.
6. If reproduction requires unavailable hardware, credentials, external state, or an unsupported OS, finish all reachable investigation and stop before commit/closure unless another deterministic check proves the acceptance criteria.

### 3. Implement the root-cause fix

1. Reuse the repository’s existing architecture and conventions. Fix the source of the behavior, not a screenshot-specific symptom.
2. Keep scope limited to the issue and necessary compatibility work. Migrate every affected caller and remove code made obsolete by the cutover.
3. Preserve documented security policy. Never broaden URL schemes, filesystem access, authentication, permissions, or executable launch behavior as a shortcut.
4. Update user-facing strings through every supported locale and update documentation when behavior or operational guidance changes.
5. Do not ship placeholders, silent fallbacks, disabled checks, product-code mocks, or `TODO` implementations.

### 4. Verify completion

1. Run the smallest existing tests that cover the changed behavior, then the relevant package typecheck/build/lint required by repository guidance.
2. Exercise the changed path itself after the fix:
   - web UI: interact through browser automation and observe the rendered result;
   - desktop UI: launch the actual app and drive or inspect the affected surface when automation is available;
   - CLI/API: run the real command/request and observe output or state.
3. Prove boundaries from the issue: normal case, relevant unsafe/unsupported inputs, state preservation, and exact data preservation where specified.
4. Required targeted checks must pass. An unrelated pre-existing broad-suite failure may be documented separately only when targeted checks and the changed runtime path pass.
5. Remove temporary repro scripts and generated scaffolding. Keep only regression tests that detect plausible consumer-visible failures.

### 5. Prepare the commit

1. Review the final scoped changes and confirm no unrelated file is staged.
2. Update documentation/changelog required by repository convention before committing.
3. Create one logical conventional commit. Use `Refs #<number>` rather than an auto-closing keyword so closure happens only after remote and issue verification. Example:

   ```text
   fix(<scope>): <concise behavior change>

   <root cause and fix, in one short paragraph>

   Refs #<number>.
   ```

4. Capture the full commit SHA and subject. Never amend an existing user commit.

### 6. Push safely and verify delivery

1. Push without force to the current branch’s intended upstream.
2. Directly push the default branch only when it is already checked out and repository policy permits direct pushes. Never switch to the default branch or bypass protection solely to finish this workflow.
3. If delivery requires review, push the feature branch and follow the repository’s existing pull-request workflow. Do **not** close the issue until the fix is merged into the branch the project treats as delivered.
4. After pushing, verify the exact full SHA is visible at `https://github.com/<owner>/<repo>/commit/<sha>` and belongs to the expected repository/branch. A successful local `git push` message alone is insufficient evidence.

### 7. Comment and close

Use an authenticated browser session when available; otherwise use an authenticated GitHub tool/API. Open the exact canonical issue and re-check owner, repository, number, title, and current state before mutating it.

1. Post a concise completion comment containing:
   - a permalink to the full commit SHA;
   - the root cause and user-visible fix;
   - exact tests/typechecks/builds and runtime scenario exercised;
   - any relevant platform limitation, stated without implying unobserved coverage.
2. Observe that the comment appears on the issue.
3. Close the issue. If GitHub already closed it through another mechanism, leave it closed; never toggle it merely to perform this step.
4. Observe the final closed state, such as the closed badge or **Reopen issue** control.
5. Close/release browser tabs opened by this workflow.

Never silently fall back from an unavailable internal action to a different external action. Never claim a push, comment, commit URL, test result, or closed state that was not observed.

## Stop states

Leave the issue open and report the exact blocker when any of these applies:

- the issue cannot be reproduced or deterministically proven;
- acceptance criteria remain incomplete;
- targeted verification fails;
- the commit is only local or the remote SHA cannot be observed;
- a feature branch or pull request is not merged into the delivered branch;
- authentication or repository permissions prevent commenting or closing;
- the issue is a duplicate, intended behavior, or already fixed and the user did not explicitly authorize administrative closure.

In a stop state, still report completed investigation, files changed, commands run, local commit/branch if any, and the single next action needed to unblock delivery.

## Final report

Return:

```text
Issue:      <owner/repo#number + title>
Status:     closed | blocked
Root cause: <one sentence>
Fix:        <one sentence>
Commit:     <full SHA + GitHub permalink>
Branch:     <pushed branch; whether delivered/merged>
Checks:     <only commands and scenarios actually observed>
GitHub:     <comment posted; final issue state observed>
Blocker:    <only when blocked>
```

<critical>
- Never close before the fix is verified, pushed, and visible on the target repository.
- Never force-push, discard unrelated work, bypass branch protection, or close an unmerged fix.
- Stage only issue-scoped files; commit with `Refs`, then close explicitly after remote verification.
- The issue comment and final report must link the observed commit and state only exercised checks.
</critical>
