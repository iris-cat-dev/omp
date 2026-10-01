---
name: create-github-release
description: >-
  Create or revise a GitHub Release through an authenticated browser, using git
  history and diffs to write accurate Chinese and English app release notes.
  Use when the user requests a release, release notes, or edits to an existing
  release draft. Keep incomplete releases as drafts until assets are ready.
---

# Create GitHub Release

Create or revise the requested release, with evidence-backed, user-facing Chinese and English notes. Verify the saved content and rendered lists. Do not publish an incomplete release or claim that unuploaded assets are available.

## Inputs and scope

- Resolve the repository from the supplied GitHub URL or the checkout's `origin`.
- Use the requested version, existing tag naming convention, previous release, and intended target branch or commit. Inspect available repository and GitHub information before asking for missing details.
- Reuse an existing release or draft for the requested version; do not create duplicates.
- If the user will upload files later, save a draft. Publish only when requested and required assets are ready.
- Do not change code, bump versions, commit, push, create local tags, or upload files unless requested. A release request does not authorize unrelated repository mutations.

## Procedure

### 1. Establish the release range

1. Inspect the repository identity, previous release/tag, requested version, and intended release target. Distinguish local `HEAD` from the remote target; notes must describe the target actually selected on GitHub.
2. Read the complete commit range, including direct commits rather than only merged pull requests:

   ```sh
   git log <previous-tag>..<target> --format='%h %s'
   git diff --stat <previous-tag>..<target>
   git show --format=fuller --stat <relevant-commit>
   git show <relevant-commit> -- <relevant-path>
   ```

3. Inspect relevant diffs and documentation to establish user-visible behavior, UI entry points, and platform limitations. Commit subjects alone are insufficient for detailed claims.
4. If the selected remote target is not present locally, obtain its history through permitted git fetching or GitHub. Do not silently substitute another range.
5. Deduplicate merges and repeated commits that implement the same behavior. Keep issue/PR links only when their relationship to the change is established.

### 2. Write app-focused bilingual notes

1. Write a Chinese section followed by an equivalent English section. Keep the same features, fixes, limitations, and removals in both.
2. Describe what users can do or what behavior is fixed, not internal implementation activity.
3. Exclude version bumps, workspace package synchronization, contributor-only skills such as GitHub Issue resolution workflows, tests, CI, and build refactors without an actual user-facing change.
4. Include a packaging option only when it changes the delivered user experience and its availability is established. A build script does not prove a release asset exists.
5. Preserve user-visible removals and compatibility changes. Avoid vague labels: for example, identify collapsed thinking/tool-call group counts rather than simply saying “activity badges.”
6. Use flat Markdown lists with exactly one bullet marker per item. Avoid unintended indentation, empty bullets, nested lists, and duplicated punctuation.
7. Include a full changelog link for the intended tags. If the new tag does not exist until publication, do not claim its compare URL already resolves.

Use this structure, filling only sections supported by actual changes:

```markdown
## 中文

### 新增功能

- **功能名称**：用户可见的行为与入口。

### 修复与优化

- 修复具体的用户可见问题。

### 功能调整

- 明确说明移除或兼容性变化。

## English

### New features

- **Feature name**: User-visible behavior and entry point.

### Fixes and improvements

- Describe the corresponding user-visible fix.

### Changes

- Describe the corresponding removal or compatibility change.

---

**完整更新记录 / Full changelog**: <compare-url>
```

### 3. Edit through the authenticated browser

1. Read `xd://eval/browser` before using browser automation. Use the user's authenticated relay or another available authenticated browser session.
2. Open the exact repository releases page. Inspect it before choosing an existing draft or creating a release.
3. Preserve existing assets and unrelated release settings. Set the requested title/tag and intended target. Do not publish merely to create a tag.
4. Treat GitHub-generated notes as supporting evidence, not the complete changelog: direct commits may be missing.
5. Insert the complete bilingual Markdown and read the textarea value back. Confirm exact equality with the intended text before saving.
6. GitHub's editor may auto-continue lists during multiline simulated typing, turning `- item` into `- - item`. If this occurs, replace the textarea value atomically in the page using the native `HTMLTextAreaElement` value setter and bubbling `input`/`change` events. Pass content as a browser-run argument rather than interpolating it into executable code. Then verify exact equality again.
7. Open Preview. Check both languages visually and inspect the release body for accidental nested lists (`li ul`, `li ol`). Every intended list item must be a sibling at its section's list level.
8. Save the draft, or publish only when the user's requested state and asset prerequisites are satisfied. Avoid repeated save/publish clicks while navigation is pending.

### 4. Verify persisted content and state

1. Return to the releases listing and locate the requested version. Observe its Draft, Pre-release, or Latest state as applicable.
2. Read the saved release body and verify both language sections, app-only scope, links, and aligned lists. Inspect the rendered release body, not unrelated navigation lists or a hidden editor panel.
3. Obtain the current edit URL from the listing after saving. GitHub can change an `untagged-*` draft identifier; an earlier edit URL may return 404 even though the save succeeded. Do not recreate the release on that basis.
4. Reopen the current editor and verify that the saved textarea exactly matches the intended Markdown. Confirm that existing assets were preserved and no unexpected files were uploaded.
5. Release browser handles opened for this task. Report the current release/edit URL, saved state, relevant changes, and any remaining asset requirements. Never describe a draft as published.

## Asset readiness

For apps using release-fed auto-updates, inspect the repository's actual update configuration and documentation. Upload installer payloads and matching metadata from the same build before publication. Typical electron-builder assets include:

- macOS: DMG, matching ZIP, and channel-specific macOS YAML metadata.
- Windows: architecture-specific installers, blockmaps, and correctly merged channel YAML metadata.
- Linux: supported update payloads and matching channel metadata.

These are examples, not a substitute for the project's configuration. Do not invent filenames, checksums, supported architectures, signing status, or uploaded assets. If uploads are deferred, finish the notes and save the draft; state exactly what remains before publication.

## Completion criteria

- The correct version and target are selected in the intended repository.
- Chinese and English notes describe the same evidence-backed app changes.
- Contributor workflows and version/build bookkeeping are excluded unless explicitly requested.
- Lists render with no duplicate markers or accidental nesting.
- Saved content has been reopened and checked, not merely previewed.
- Release state and asset handling match the request.
- The final response links the current release or draft and reports only observed results.
