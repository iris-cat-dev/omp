# Agent and harness benchmark plan

Recorded on 2026-11-08 for a future evaluation. No benchmark runs or scores are recorded here.

## Recommended starting point

Use **Harbor + Terminal-Bench** to evaluate the OMP coding harness. Add **SWE-bench Verified** for real repository issue resolution. Consult **Harness Leaderboard** for existing same-model harness comparisons.

An agent benchmark measures the complete system: model, prompts, tools, context management, and execution loop. To compare harnesses, keep the model, provider, reasoning effort, task inputs, and resource budgets fixed; change only the harness. Different-model leaderboard entries do not isolate harness quality.

## Projects and reference material

| Project                                                                              | What it provides                                                                                                                                                                                                                                   | Use in the next evaluation                                                                                   |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Harness Leaderboard](https://huggingface.co/spaces/joelniklaus/harness-leaderboard) | Same-model/provider/task/reasoning-effort comparisons of nine coding harnesses, using Terminal-Bench 2.1, SWE-bench Pro, and FeatureBench; scores, confidence intervals, cost, time, and public trajectories. Runs are launched by the maintainer. | Reference methodology and existing comparisons; not the runner for our own evaluation.                       |
| [Harbor](https://docs.harborframework.com/)                                          | Evaluation runner connecting agents, models, tasks, and sandboxes; supports custom agent integrations.                                                                                                                                             | Run the candidate and baseline under the same evaluation setup. Harbor is a runner, not a benchmark dataset. |
| [Terminal-Bench](https://www.tbench.ai/)                                             | Difficult tasks completed in terminal environments, with task-specific verification.                                                                                                                                                               | Primary coding-harness benchmark. Pin a published dataset release or commit.                                 |
| [SWE-bench Verified](https://www.swebench.com/verified)                              | 500 human-filtered real GitHub issue-resolution tasks.                                                                                                                                                                                             | Complement terminal tasks with repository understanding, patches, and test-based verification.               |
| [harness-bench](https://github.com/ajrrac/harness-bench)                             | A fixed subset of 10 difficult Terminal-Bench 2.0 tasks, three attempts per task, run through Harbor.                                                                                                                                              | Optional small comparison setup; its narrow task selection is not sufficient for a general ranking.          |
| [AgentBench](https://github.com/THUDM/AgentBench)                                    | Multi-environment agent evaluation; the current repository includes a Function Calling version.                                                                                                                                                    | Broader tool-use evaluation if that becomes the target.                                                      |
| [tau2-bench / τ-bench](https://github.com/sierra-research/tau2-bench)                | Customer-service interactions, tool use, and policy compliance in airline, retail, and telecom domains; current releases also support voice and multiple languages.                                                                                | Business-workflow agents rather than the initial coding-harness comparison.                                  |
| [OSWorld](https://os-world.github.io/)                                               | Open-ended tasks in real computer environments.                                                                                                                                                                                                    | Computer-use agents; separate from terminal-only evaluation and Desktop UI acceptance.                       |

Project versions evolve. The Harness Leaderboard dataset versions and the small harness-bench subset above describe those projects, not a required version for our run. Select and record the actual dataset release before testing; do not use an unpinned `latest` reference for comparisons.

## Next-session execution sequence

1. **Define the candidate and baseline.** Start with OMP and one baseline that can use the same model and provider. State whether the candidate is the native OMP SDK or the Desktop-managed daemon/RPC path with its host tools. An SDK-only score does not establish Desktop-specific tool behavior or GUI quality.
2. **Freeze the configuration.** Record the Desktop revision and local changes, pinned `omp-sdk/` revision and local changes, harness versions, Harbor version, dataset release/commit, exact task IDs, model/provider, reasoning effort, sampling settings, enabled tools/skills, approval mode, and token/time/resource budgets. Agree a spending cap before billable runs.
3. **Integrate OMP with Harbor.** Use the SDK runtime selected by this project, not an unrelated system `omp` executable. Follow [custom-agent integration](https://docs.harborframework.com/agents/custom-agents.md). Prefer an installed agent when the complete runtime can execute inside the task sandbox; use an external agent only when it must run outside and all task operations are routed through the sandbox. Preserve the candidate's real tool behavior rather than replacing it with a simplified loop.
4. **Prove one task end to end.** In a fresh sandbox, run the task's oracle solution to check the environment and verifier. Then run OMP and the baseline on that task; inspect actual task changes, verifier results, trajectories, usage, and process completion. Use isolated profiles and sessions. Do not expose the working checkout, personal files, signed-in browser, or unrelated credentials to benchmark tasks.
5. **Run a fixed pilot.** Select 5–10 representative tasks before seeing results, use the same task list for both harnesses, and run each task three times with concurrency one initially. Report per-task passes out of three and mean per-attempt success; do not turn “any attempt passed” into a single-attempt success rate. Diagnose integration failures before scaling up.
6. **Run the full selected release.** After the pilot is valid and the spending cap is approved, evaluate the full dataset with the same configuration for both harnesses. Follow the benchmark's submission protocol if publishing results. Keep pilot/subset scores separate from full-dataset scores; add SWE-bench Verified as a separately reported benchmark.

Resume at step 1; the first OMP trial requires a runnable Harbor integration for the selected runtime.

### Harbor command reference

Start with the selected Harbor version's CLI and [job-running guide](https://docs.harborframework.com/jobs/run-a-job.md):

```bash
harbor --version
harbor run --help
```

The current documentation supports `-d` for a pinned dataset reference, `-a` for a built-in agent or importable `module.path:ClassName`, `-m` for the model, `--effort` for reasoning effort, `-n` for concurrency, `-k` for attempts, and `-r` for retries. Verify these against the installed version before constructing the actual command. Use `--print-config` to inspect the resolved job configuration before execution.

Inspect completed local jobs with:

```bash
harbor view ./jobs
```

Use a dedicated benchmark directory for jobs and runtime state. Keep API credentials in the supported credential/configuration mechanism, never in committed commands, configs, or results. Do not upload raw trajectories before checking them for secrets and private data.

## Results to retain

For each run, retain:

- Run date and ID, candidate/baseline identity, exact command and resolved job configuration with secrets removed.
- Desktop, SDK, harness, Harbor, and dataset revisions, including relevant uncommitted changes.
- Exact model/provider, reasoning effort, sampling settings, tools/skills, approval mode, and resource budgets.
- Task IDs, attempts per task, verifier outcomes, and per-task pass counts.
- Mean per-attempt success and, for sufficiently sized runs, confidence intervals.
- Input/output token usage, reported cost and its pricing basis, and wall time. Mark unavailable values as unavailable rather than estimating them silently.
- Agent failures, timeouts, infrastructure failures, and retries separately. Show total scheduled trials and any exclusions so failures do not disappear from the denominator without explanation.
- Redacted trajectories, verifier output, representative failure analysis, and local artifact paths.

Public tasks can appear in training data. Record the evaluation date and compare contemporaneous runs on the same pinned inputs. A small pilot provides integration evidence, not a definitive overall ranking.

For the project's runtime and state conventions, see [Development and verification](development.md#omp-sdk-backend). Desktop UI verification remains a separate acceptance step under the [verification policy](development.md#verification-policy).
