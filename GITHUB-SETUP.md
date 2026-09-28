# GitHub publication and identity setup

This guide is for a **new public `battlebawt/steward-public` repository**. Review the curated source and its history for material that should stay private before publication. Keep the existing private `battlebawt/steward` repository private; changing its visibility would expose its revision history and potentially its Actions logs. [GitHub explains the visibility effects](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).

## Confirm the account before any push

Authenticate with `battlebawt` through a normal GitHub login flow. In the terminal that will publish the repository, run:

```sh
gh auth status --active --hostname github.com
gh api user --jq .login
git remote get-url --push origin
```

The API result must be exactly `battlebawt`, and the push URL must be exactly `https://github.com/battlebawt/steward-public.git` (or the same URL without `.git`). Stop if either differs or authentication fails. Set the local Git author email to one verified on that account and inspect the author/committer of each proposed commit. The local guard expects `battlebawt` and `279315923+battlebawt@users.noreply.github.com`, the identity recorded in the existing Steward commits; confirm that email is still accepted by the GitHub account. Do not print tokens or credential-helper output while checking identity. If Git uses a separate SSH key or credential helper from GitHub CLI, verify that transport is also tied to `battlebawt`; the `gh` account check alone cannot prove which account Git will use for a push. [GitHub CLI documents its active-account check](https://cli.github.com/manual/gh_auth_status) and [authenticated API requests](https://cli.github.com/manual/gh_api).

After the new repository is initialized, configure its local mistake guard with `git config --local core.hooksPath .githooks` and connect GitHub CLI to the HTTPS Git credential flow with `gh auth setup-git`. The included `pre-push` hook rejects the private repository URL, other public remotes, an active CLI login under another account, and unexpected local author settings. Test it against a wrong-account fixture before the first push. Hooks are local and bypassable; use the remote ruleset and narrow write access as the lasting controls.

The existing private Steward history was authored as `battlebawt` and starts on 22 September 2026. Publish this curated public snapshot with its actual publication date; it does not contain the private Git history. Do not backdate, invent, or split changes into 250 supposed June commits. The [contribution graph uses author date, connected email and eligible branches](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference); it is not proof of when work began.

## Protect the public default branch

After the initial reviewed publication, open **Settings → Rules → Rulesets → New branch ruleset** for `main`, turn enforcement **Active**, and keep the bypass list empty. Select **Require signed commits**, **Block force pushes**, and **Restrict deletions**. Add passing CI checks once their names are stable. Set repository write access narrowly; for a personal repository, do not add collaborators who should not publish. Confirm the ruleset is active and test a normal signed change through the intended workflow. [GitHub lists these rules and their effects](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) and [documents ruleset creation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository).

The included `.github/CODEOWNERS` assigns all files and the ownership file to `@battlebawt`. This requests that owner as a reviewer on pull requests. It does not itself prevent pushes. Do not enable a required code-owner approval for a one-person workflow unless a second trusted reviewer is available: [GitHub does not let an author approve their own pull request](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews). The [CODEOWNERS guide](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) explains ownership and the separate review rule.

## Preserve a verifiable publication record

Sign new commits with a signing key registered to `battlebawt` and check GitHub's **Verified** status. For a release, record the source commit hash, export date, file inventory/checksums, and the earlier private source revision (if disclosed) in a provenance manifest. Create a signed annotated release tag and verify it locally with `git tag -v`; retain a copy of the manifest and tag verification outside GitHub. [GitHub supports verified commit and tag signatures](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification) and [documents signed tags](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-tags).

GitHub's activity view associates pushes and force pushes with authenticated users, but it is **not an immutable ledger**. Repository administrators can edit rulesets, and history or visibility can change. Signatures, protected branches, narrow write access and an independently retained release record make unauthorized or accidental changes easier to prevent and detect; none is foolproof. [GitHub's activity view](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/analyzing-changes-to-a-repositorys-content) and [ruleset administration](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository) document those limits.
