# Changelog

## [1.16.0](https://github.com/spietrza/taskcell/compare/v1.15.3...v1.16.0) (2026-11-14)


### Features

* Approver: act mode — update, re-check and merge a reviewed green factory PR (spietrza/taskcell[#930](https://github.com/spietrza/taskcell/issues/930)) ([#936](https://github.com/spietrza/taskcell/issues/936)) ([3767cce](https://github.com/spietrza/taskcell/commit/3767cce51b1d8b461276a9da60b10dd9c039576e))
* Audit trail: one audit record module (hash chain, actor and subject, verify, export, retention) (spietrza/taskcell[#871](https://github.com/spietrza/taskcell/issues/871)) ([#886](https://github.com/spietrza/taskcell/issues/886)) ([97a5c9e](https://github.com/spietrza/taskcell/commit/97a5c9e1ade818396ed5fe3176c21c849bca56ab))
* Audit trail: per-issue history (hub tab + taskcell history) over the audit streams (spietrza/taskcell[#872](https://github.com/spietrza/taskcell/issues/872)) ([#899](https://github.com/spietrza/taskcell/issues/899)) ([814eb77](https://github.com/spietrza/taskcell/commit/814eb77947535ded390b672725e8f7ea21e71452))
* Codex fallback fails in the sandbox with EAGAIN on spawn (spietrza/taskcell[#800](https://github.com/spietrza/taskcell/issues/800)) ([#816](https://github.com/spietrza/taskcell/issues/816)) ([69f6b52](https://github.com/spietrza/taskcell/commit/69f6b52f99ca5d62a129557b2999663a656742f9))
* daily agent CLI bump PR (claude, codex) ([#812](https://github.com/spietrza/taskcell/issues/812)) ([83a9d79](https://github.com/spietrza/taskcell/commit/83a9d79ba0e13a0ec3f92b956c72d168833d28b1))
* Desktop app: connect to a remote hub (server mode) (spietrza/taskcell[#859](https://github.com/spietrza/taskcell/issues/859)) ([#883](https://github.com/spietrza/taskcell/issues/883)) ([eea6d5b](https://github.com/spietrza/taskcell/commit/eea6d5be0d57115b6260a581885ca074447e4adf))
* Desktop app: installers for macOS, Windows and Linux, auto-update, Download link (spietrza/taskcell[#851](https://github.com/spietrza/taskcell/issues/851)) ([#857](https://github.com/spietrza/taskcell/issues/857)) ([7ea5b2e](https://github.com/spietrza/taskcell/commit/7ea5b2e84f6c73f812b7083f8b0b258e13d01d46))
* Desktop app: the local hub is the only backend (drop the Rust commands) (spietrza/taskcell[#852](https://github.com/spietrza/taskcell/issues/852)) ([#864](https://github.com/spietrza/taskcell/issues/864)) ([7887955](https://github.com/spietrza/taskcell/commit/78879555dc8cc4d8f4dc1039569c608199274d09))
* Enable factory: optional taskcell GitHub App in the generated callers + stale label in diagrams (spietrza/taskcell[#824](https://github.com/spietrza/taskcell/issues/824)) ([#832](https://github.com/spietrza/taskcell/issues/832)) ([6d588f1](https://github.com/spietrza/taskcell/commit/6d588f15fa004c5b45399e96295f68bda59cd51c))
* Factory PRs authored by the taskcell GitHub App (just-in-time installation token) (spietrza/taskcell[#815](https://github.com/spietrza/taskcell/issues/815)) ([#820](https://github.com/spietrza/taskcell/issues/820)) ([a68bae4](https://github.com/spietrza/taskcell/commit/a68bae40c0cbc3f3649e98c035e2f41166894966))
* Factory: hold an issue whose planned files overlap an open factory PR (after [#868](https://github.com/spietrza/taskcell/issues/868)) (spietrza/taskcell[#869](https://github.com/spietrza/taskcell/issues/869)) ([#898](https://github.com/spietrza/taskcell/issues/898)) ([982ffed](https://github.com/spietrza/taskcell/commit/982ffed27878b907b55fe036038b791ddf5e1d60))
* Factory: task dependencies on GitHub (blocked-by and 'Depends on #N') (spietrza/taskcell[#769](https://github.com/spietrza/taskcell/issues/769)) ([#818](https://github.com/spietrza/taskcell/issues/818)) ([6103001](https://github.com/spietrza/taskcell/commit/61030010d608bb6a1b8730951cf74850a6127271))
* hub: "Open in GitHub / GitLab / Linear" links on cards, runs, pull requests and diffs (spietrza/taskcell[#829](https://github.com/spietrza/taskcell/issues/829)) ([#845](https://github.com/spietrza/taskcell/issues/845)) ([c322020](https://github.com/spietrza/taskcell/commit/c322020d019bb05eefdc363b35d1d01c4e90f982))
* hub: adopt the Taskcell prototype as the design direction (decision record, DESIGN.md, tokens) (spietrza/taskcell[#772](https://github.com/spietrza/taskcell/issues/772)) ([#875](https://github.com/spietrza/taskcell/issues/875)) ([523f7ab](https://github.com/spietrza/taskcell/commit/523f7ab6e867d86847dfa7a666e26c5aa91f19a7))
* hub: approver scorecard beside the auto-merge switch (last 90 days), decision on the task (spietrza/taskcell[#934](https://github.com/spietrza/taskcell/issues/934)) ([#942](https://github.com/spietrza/taskcell/issues/942)) ([de91b74](https://github.com/spietrza/taskcell/commit/de91b74724652bd1538322b071caf2766e5f3da4))
* hub: audit log of who started runs and changed settings (spietrza/taskcell[#621](https://github.com/spietrza/taskcell/issues/621)) ([#870](https://github.com/spietrza/taskcell/issues/870)) ([c6771cb](https://github.com/spietrza/taskcell/commit/c6771cbdb02f7104efefbe3c80cf21a83dccb80f))
* hub: card quick view with the stage line and the receipt (side panel, bottom drawer on phones) (spietrza/taskcell[#874](https://github.com/spietrza/taskcell/issues/874)) ([#892](https://github.com/spietrza/taskcell/issues/892)) ([1227131](https://github.com/spietrza/taskcell/commit/122713105ecc476416af4e6276f7bbb571d922d6))
* hub: demo mode with a seeded project (spietrza/taskcell[#776](https://github.com/spietrza/taskcell/issues/776)) ([#894](https://github.com/spietrza/taskcell/issues/894)) ([ca8a200](https://github.com/spietrza/taskcell/commit/ca8a20067eda690e337b5264b84b70b4c8dc1f11))
* hub: Enable factory as an in-app checklist (secret check, merge detection, live doctor) (spietrza/taskcell[#774](https://github.com/spietrza/taskcell/issues/774)) ([#906](https://github.com/spietrza/taskcell/issues/906)) ([d120ee6](https://github.com/spietrza/taskcell/commit/d120ee669c2197206064adb88fa87f9b3ce35aba))
* hub: first-run onboarding wizard and helpful empty states (spietrza/taskcell[#773](https://github.com/spietrza/taskcell/issues/773)) ([#907](https://github.com/spietrza/taskcell/issues/907)) ([e557a92](https://github.com/spietrza/taskcell/commit/e557a92ca1a4b709f8009da83c5aa5ea33edfa78))
* hub: instance provider credentials in Settings, encrypted at rest (spietrza/taskcell[#619](https://github.com/spietrza/taskcell/issues/619)) ([#856](https://github.com/spietrza/taskcell/issues/856)) ([aa0a983](https://github.com/spietrza/taskcell/commit/aa0a983a4ed36d5275af49c17f1a687afe6a7a33))
* hub: Lessons view per project (list, evidence link, dismiss) (spietrza/taskcell[#923](https://github.com/spietrza/taskcell/issues/923)) ([#931](https://github.com/spietrza/taskcell/issues/931)) ([92d99c0](https://github.com/spietrza/taskcell/commit/92d99c00ccab2cc2124bbe2920eb40b04346cbde))
* hub: merge a pull request and ask for changes from Sign-off (spietrza/taskcell[#827](https://github.com/spietrza/taskcell/issues/827)) ([#844](https://github.com/spietrza/taskcell/issues/844)) ([9311a90](https://github.com/spietrza/taskcell/commit/9311a9096bf5ee21f45a5b91e0fa401bb1024eaa))
* hub: navigation from the prototype (Home, Board, Runs, Settings; sign-off on Home; Line and Runners under Settings) (spietrza/taskcell[#873](https://github.com/spietrza/taskcell/issues/873)) ([#891](https://github.com/spietrza/taskcell/issues/891)) ([291da64](https://github.com/spietrza/taskcell/commit/291da64667bb1d3338cdf971698b081e77f24f02))
* Hub: new agent CLI versions (claude, codex, cursor) with an Update button (spietrza/taskcell[#813](https://github.com/spietrza/taskcell/issues/813)) ([#819](https://github.com/spietrza/taskcell/issues/819)) ([fed4a54](https://github.com/spietrza/taskcell/commit/fed4a547928f9d3f9a7d46ccfa01c2a067d7d7b7))
* Hub: one command module per feature (derive wire Commands, COMMAND_NAMES and dispatch) (spietrza/taskcell[#868](https://github.com/spietrza/taskcell/issues/868)) ([#895](https://github.com/spietrza/taskcell/issues/895)) ([4114907](https://github.com/spietrza/taskcell/commit/4114907c47a97e909a5b12cddfd18bb8c79db459))
* hub: one repository filter for Board and Runs (All repositories + one repository) (spietrza/taskcell[#826](https://github.com/spietrza/taskcell/issues/826)) ([#838](https://github.com/spietrza/taskcell/issues/838)) ([e04d69d](https://github.com/spietrza/taskcell/commit/e04d69dc2ebff99df92f25b7f949ddcc48e7097c))
* hub: per-project task source and run location (GitHub, GitLab, Linear, self-hosted, local) (spietrza/taskcell[#775](https://github.com/spietrza/taskcell/issues/775)) ([#888](https://github.com/spietrza/taskcell/issues/888)) ([a1ebe03](https://github.com/spietrza/taskcell/commit/a1ebe036b1ab13a304879c5e8bfcdb42056e4706))
* hub: per-user provider credentials behind an admin switch (spietrza/taskcell[#620](https://github.com/spietrza/taskcell/issues/620)) ([#853](https://github.com/spietrza/taskcell/issues/853)) ([eb5ddf5](https://github.com/spietrza/taskcell/commit/eb5ddf5ddfe4797751427fcc48e4c3c38fd17ff5))
* Hub: persisted run event log (survives restart, readable per run) (spietrza/taskcell[#830](https://github.com/spietrza/taskcell/issues/830)) ([#865](https://github.com/spietrza/taskcell/issues/865)) ([d235056](https://github.com/spietrza/taskcell/commit/d23505668107695874fd22169a448dbbbdfccaf0))
* hub: persistent token file for server mode (spietrza/taskcell[#616](https://github.com/spietrza/taskcell/issues/616)) ([#839](https://github.com/spietrza/taskcell/issues/839)) ([70e8ddb](https://github.com/spietrza/taskcell/commit/70e8ddba7d386e39b023a5969b9ff0d34a0342ef))
* hub: responsive layout foundation (narrow screens, 390 px) (spietrza/taskcell[#778](https://github.com/spietrza/taskcell/issues/778)) ([#887](https://github.com/spietrza/taskcell/issues/887)) ([bcbec7e](https://github.com/spietrza/taskcell/commit/bcbec7e27b1431d0b185a73ad120bb1e47d74084))
* hub: show the cost of CI factory runs (metrics branch) and a breakdown by model and stage (spietrza/taskcell[#925](https://github.com/spietrza/taskcell/issues/925)) ([#932](https://github.com/spietrza/taskcell/issues/932)) ([2b5c334](https://github.com/spietrza/taskcell/commit/2b5c334bc23be0c9449a69851dcc5a10618daab8))
* hub: sign-in for server mode with Better Auth (GitHub, GitLab, Google; allowlist; SQLite) (spietrza/taskcell[#617](https://github.com/spietrza/taskcell/issues/617)) ([#866](https://github.com/spietrza/taskcell/issues/866)) ([5378e5f](https://github.com/spietrza/taskcell/commit/5378e5f12a817f02a009be37c9018f49e6c51dab))
* Hub: start the factory on an existing issue (apply the trigger label from the hub) (spietrza/taskcell[#831](https://github.com/spietrza/taskcell/issues/831)) ([#837](https://github.com/spietrza/taskcell/issues/837)) ([a18aff7](https://github.com/spietrza/taskcell/commit/a18aff7f65914afc271648e16d45327ea7547181))
* hub: target branch per card (dev, UAT, main) (spietrza/taskcell[#828](https://github.com/spietrza/taskcell/issues/828)) ([#846](https://github.com/spietrza/taskcell/issues/846)) ([4f77059](https://github.com/spietrza/taskcell/commit/4f7705932ddeb1df3886f399d3c13761dbcd794a))
* hub: teams 1/3 — store teams and move existing projects into a default team (spietrza/taskcell[#840](https://github.com/spietrza/taskcell/issues/840)) ([#847](https://github.com/spietrza/taskcell/issues/847)) ([541c1fb](https://github.com/spietrza/taskcell/commit/541c1fb3227301eb0abc114f4d48e203a9ef4334))
* hub: teams 2/3 — every list is limited to the caller's team, and roles are checked on the server (spietrza/taskcell[#841](https://github.com/spietrza/taskcell/issues/841)) ([#884](https://github.com/spietrza/taskcell/issues/884)) ([00e4d5f](https://github.com/spietrza/taskcell/commit/00e4d5ff6aaa7007ad3215d2707c4887a09941a5))
* hub: teams 3/3 — team switcher and a members screen (spietrza/taskcell[#842](https://github.com/spietrza/taskcell/issues/842)) ([#885](https://github.com/spietrza/taskcell/issues/885)) ([500d687](https://github.com/spietrza/taskcell/commit/500d687a3831f8afd338e5fd1d6058b86fa7fbee))
* hub: the full filter bar for Board and Runs (triage, projects, source, runner, search, grouping) (spietrza/taskcell[#855](https://github.com/spietrza/taskcell/issues/855)) ([#901](https://github.com/spietrza/taskcell/issues/901)) ([1cb209c](https://github.com/spietrza/taskcell/commit/1cb209c079d1672a6bc5af8112a55bdfe1ae9ff5))
* hub: UI polish from the audit (widths, errors, copy, ⌘K, focus, consistency) (spietrza/taskcell[#777](https://github.com/spietrza/taskcell/issues/777)) ([#903](https://github.com/spietrza/taskcell/issues/903)) ([01ca907](https://github.com/spietrza/taskcell/commit/01ca90741b6d716f75652e105891452d66136297))
* Lessons for GitLab merge requests (spietrza/taskcell[#924](https://github.com/spietrza/taskcell/issues/924)) ([#928](https://github.com/spietrza/taskcell/issues/928)) ([b4b528a](https://github.com/spietrza/taskcell/commit/b4b528afc8682119b213db9c5a0edb2f4fbbd6fc))
* Lessons: give a run the lessons for the files it changes, and record which ones it got (spietrza/taskcell[#921](https://github.com/spietrza/taskcell/issues/921)) ([#933](https://github.com/spietrza/taskcell/issues/933)) ([5332847](https://github.com/spietrza/taskcell/commit/533284736c8f24ffa0de83203f0ec2cd8ca9f5b1))
* Lessons: record how many lessons a run loaded and report the first-pass review rate (spietrza/taskcell[#971](https://github.com/spietrza/taskcell/issues/971)) ([#975](https://github.com/spietrza/taskcell/issues/975)) ([359ed4f](https://github.com/spietrza/taskcell/commit/359ed4f6ead5e30edacb7d7b2c76b0a2f8c9d194))
* Loop: run verify and the secret scan before the model review (spietrza/taskcell[#929](https://github.com/spietrza/taskcell/issues/929)) ([#935](https://github.com/spietrza/taskcell/issues/935)) ([b9ecef7](https://github.com/spietrza/taskcell/commit/b9ecef7a4ce25665e62350b6761a8e8c8edf878b))
* Rename: VANGUARD_* variables, branch prefix and remaining user-visible names to Taskcell (old names still read) (spietrza/taskcell[#950](https://github.com/spietrza/taskcell/issues/950)) ([#962](https://github.com/spietrza/taskcell/issues/962)) ([1fb750f](https://github.com/spietrza/taskcell/commit/1fb750f7df6e84bd383d9f069797754457d9a4c5))
* Rename: vanguard:* labels and comment markers to taskcell:* (old names still recognised) (spietrza/taskcell[#850](https://github.com/spietrza/taskcell/issues/850)) ([#917](https://github.com/spietrza/taskcell/issues/917)) ([b9f6c9a](https://github.com/spietrza/taskcell/commit/b9f6c9ae25653218d84f4a833aa282aa75100735))
* Review: incremental re-review (track previous findings, stable severity, skip same SHA) (spietrza/taskcell[#862](https://github.com/spietrza/taskcell/issues/862)) ([#867](https://github.com/spietrza/taskcell/issues/867)) ([1da9c40](https://github.com/spietrza/taskcell/commit/1da9c40b3503f220531503c0cce6921853c7e6cc))
* Revise: bring a factory branch with earlier merge commits up to date when the base changed CI config (spietrza/taskcell[#881](https://github.com/spietrza/taskcell/issues/881)) ([#882](https://github.com/spietrza/taskcell/issues/882)) ([4353777](https://github.com/spietrza/taskcell/commit/435377786d65b701bad76076066b47dc0e8cbb2d))
* Revise: discharge required PR-body items safely (spietrza/taskcell[#761](https://github.com/spietrza/taskcell/issues/761)) ([#834](https://github.com/spietrza/taskcell/issues/834)) ([11b4aa9](https://github.com/spietrza/taskcell/commit/11b4aa9fa98fcbf5c5615834921a5d0825e06c92))
* Revise: hand a PR to a human after a round that pushed nothing (spietrza/taskcell[#970](https://github.com/spietrza/taskcell/issues/970)) ([#973](https://github.com/spietrza/taskcell/issues/973)) ([2e58d77](https://github.com/spietrza/taskcell/commit/2e58d77e328ad8e77d658d5ed70e0af36c757e2f))
* Revise: merge-only rounds skip the revision cap and full re-review; record conflict metrics (spietrza/taskcell[#876](https://github.com/spietrza/taskcell/issues/876)) ([#889](https://github.com/spietrza/taskcell/issues/889)) ([903b917](https://github.com/spietrza/taskcell/commit/903b917c2f1163ed276d676222bc8aa4b652847a))
* Revise: per-finding checklist in the Revision Summary and automatic re-review after a push (spietrza/taskcell[#863](https://github.com/spietrza/taskcell/issues/863)) ([#877](https://github.com/spietrza/taskcell/issues/877)) ([fb8673f](https://github.com/spietrza/taskcell/commit/fb8673ff982f0c4cd38540f79e0f44c7ddeb24ee))
* Revise: resolve conflicts with the base branch, never report success on a still-conflicting PR (spietrza/taskcell[#854](https://github.com/spietrza/taskcell/issues/854)) ([#858](https://github.com/spietrza/taskcell/issues/858)) ([0954a81](https://github.com/spietrza/taskcell/commit/0954a81f96bcd9c26e2ff6125b89c91d566aca50))
* Revise: update a branch whose base changed CI config (rebase factory branches, no workflow push) (spietrza/taskcell[#878](https://github.com/spietrza/taskcell/issues/878)) ([#879](https://github.com/spietrza/taskcell/issues/879)) ([edc68f5](https://github.com/spietrza/taskcell/commit/edc68f55b9c56e6d96c570a44ca57bb7cd919e3a))
* Tests: keep the legacy spellings 'Vanguard Doctor' and '## Vanguard Tech Spec' covered (spietrza/taskcell[#966](https://github.com/spietrza/taskcell/issues/966)) ([#969](https://github.com/spietrza/taskcell/issues/969)) ([c450756](https://github.com/spietrza/taskcell/commit/c4507563e07f66f041675cde57afc9e23fab4ac2))
* workflows accept and create taskcell names ([#850](https://github.com/spietrza/taskcell/issues/850), steps 1-2) ([#982](https://github.com/spietrza/taskcell/issues/982)) ([4cd58c6](https://github.com/spietrza/taskcell/commit/4cd58c6a0e5c4a2a56366006a30240a4abc7864f))


### Bug Fixes

* Approver act mode: close the gating gaps before it can be enabled (spietrza/taskcell[#939](https://github.com/spietrza/taskcell/issues/939)) ([#943](https://github.com/spietrza/taskcell/issues/943)) ([d80c673](https://github.com/spietrza/taskcell/commit/d80c6732776a6690f98f52a90e44b318735900c0))
* Approver act mode: second gating round before it can be enabled (spietrza/taskcell[#958](https://github.com/spietrza/taskcell/issues/958)) ([#960](https://github.com/spietrza/taskcell/issues/960)) ([e08a90e](https://github.com/spietrza/taskcell/commit/e08a90e6eb1b7bef8e9709705e495fb6d681f430))
* Approver act mode: second gating round before it can be enabled (spietrza/taskcell[#958](https://github.com/spietrza/taskcell/issues/958)) ([#974](https://github.com/spietrza/taskcell/issues/974)) ([7296582](https://github.com/spietrza/taskcell/commit/729658282945eb11d224f90c152d4c56c9124e2c))
* Audit log: upgrade deletes old files, and a lock dir or null line stops appends (regression from [#886](https://github.com/spietrza/taskcell/issues/886)) (spietrza/taskcell[#946](https://github.com/spietrza/taskcell/issues/946)) ([#955](https://github.com/spietrza/taskcell/issues/955)) ([26486f6](https://github.com/spietrza/taskcell/commit/26486f6e7fe67eaf5182edee128551d4d27e8c88))
* compose keeps the old-name sandbox cap; passing verify tail keeps up to 40 lines ([#968](https://github.com/spietrza/taskcell/issues/968)) ([3a465c9](https://github.com/spietrza/taskcell/commit/3a465c9e6d2a84379eb67b59f76af4e051e4c773))
* Conformance gate id encoding and unreadable verify tail (spietrza/taskcell[#949](https://github.com/spietrza/taskcell/issues/949)) ([#956](https://github.com/spietrza/taskcell/issues/956)) ([0b5631e](https://github.com/spietrza/taskcell/commit/0b5631e0995f4c7a65e411e3c5c813a2aad471f4))
* Copy-back: apply file deletions made in the sandbox to the worktree (spietrza/taskcell[#890](https://github.com/spietrza/taskcell/issues/890)) ([#893](https://github.com/spietrza/taskcell/issues/893)) ([9a23a16](https://github.com/spietrza/taskcell/commit/9a23a1618e6d5dfec928c723266ebb9661561c60))
* custom provider keyEnv cannot name Taskcell or host credentials; hub server follow-ups ([#983](https://github.com/spietrza/taskcell/issues/983)) ([60067eb](https://github.com/spietrza/taskcell/commit/60067ebd571e13f7eabdc3f5d42a62dbca855751))
* Desktop: add a repo outside home, clean hub env, remove dead Rust (regressions from [#864](https://github.com/spietrza/taskcell/issues/864)) (spietrza/taskcell[#948](https://github.com/spietrza/taskcell/issues/948)) ([#954](https://github.com/spietrza/taskcell/issues/954)) ([861f8ad](https://github.com/spietrza/taskcell/commit/861f8ad634ee2c4c39908526ab4a2103b1250265))
* Desktop: Rust is never built in CI; lock was stale and could resolve a vulnerable zip (spietrza/taskcell[#964](https://github.com/spietrza/taskcell/issues/964)) ([#965](https://github.com/spietrza/taskcell/issues/965)) ([c138483](https://github.com/spietrza/taskcell/commit/c13848376247422f0b9e5f2211f219388026597f))
* factory follow-ups from the 1.16.0 reviews (review, approver, lessons stats, labels) ([#985](https://github.com/spietrza/taskcell/issues/985)) ([29a08f0](https://github.com/spietrza/taskcell/commit/29a08f0e56af1b5d77115f9174b5363d1db3f9f5))
* hub UI and revise hand-off fixes from the pre-release QA pass ([#976](https://github.com/spietrza/taskcell/issues/976)) ([c22da2d](https://github.com/spietrza/taskcell/commit/c22da2d54b90d662f42a1270befc1773ad788616))
* hub UI follow-ups from the browser passes ([#967](https://github.com/spietrza/taskcell/issues/967)) ([#984](https://github.com/spietrza/taskcell/issues/984)) ([7261eaa](https://github.com/spietrza/taskcell/commit/7261eaa60adb990987585a2fc2b3d082ad3ffb27))
* hub: approver card — safe mode switch, own-repo reads, off always works (spietrza/taskcell[#957](https://github.com/spietrza/taskcell/issues/957)) ([#961](https://github.com/spietrza/taskcell/issues/961)) ([7191955](https://github.com/spietrza/taskcell/commit/719195520e574f68facaef0c66c561b97896af0b))
* hub: Enable factory — planned run locations link to their tracking issues, not to a search (spietrza/taskcell[#914](https://github.com/spietrza/taskcell/issues/914)) ([#918](https://github.com/spietrza/taskcell/issues/918)) ([160a9ee](https://github.com/spietrza/taskcell/commit/160a9ee0d9e1099c4ce71d8a51a6a5205eb6ed11))
* hub: http links, live run from the rail, empty-team rail, CSP, sign-in docs (regressions) (spietrza/taskcell[#947](https://github.com/spietrza/taskcell/issues/947)) ([#953](https://github.com/spietrza/taskcell/issues/953)) ([9adeb1e](https://github.com/spietrza/taskcell/commit/9adeb1e3229b8d6e46bc44a91bab1f6da4bf7f4f))
* hub: setup guide — the model credential step cannot become Done after codex login or an export (spietrza/taskcell[#909](https://github.com/spietrza/taskcell/issues/909)) ([#910](https://github.com/spietrza/taskcell/issues/910)) ([36bfc20](https://github.com/spietrza/taskcell/commit/36bfc2001c96dad94ad5ae5a11e2c962b4a4c4b0))
* hub: user-first credentials fall back to the instance per provider (spietrza/taskcell[#915](https://github.com/spietrza/taskcell/issues/915)) ([#919](https://github.com/spietrza/taskcell/issues/919)) ([14e8c78](https://github.com/spietrza/taskcell/commit/14e8c785a7846c22b0a45c25dfa3e3af96ffc456))
* Labels and audit: leftovers from the regression fixes (spietrza/taskcell[#959](https://github.com/spietrza/taskcell/issues/959)) ([#963](https://github.com/spietrza/taskcell/issues/963)) ([fa44b93](https://github.com/spietrza/taskcell/commit/fa44b9397b1f2ec8589f0e66b82ea8542b48c873))
* Labels: legacy vanguard:* spelling ignored in five places (regression from [#917](https://github.com/spietrza/taskcell/issues/917)) (spietrza/taskcell[#945](https://github.com/spietrza/taskcell/issues/945)) ([#952](https://github.com/spietrza/taskcell/issues/952)) ([83562f4](https://github.com/spietrza/taskcell/commit/83562f47c166def0524c89779fe86d7f36a78d89))
* **landing:** one six-step story, phone nav, copy buttons ([#833](https://github.com/spietrza/taskcell/issues/833)) ([70b08dd](https://github.com/spietrza/taskcell/commit/70b08dd238c5cca305920752cd6a82d9f39329ff))
* Per-model limit ("You've reached your Fable limit") is not treated as a rate limit: run fails, work is lost, label stays (spietrza/taskcell[#900](https://github.com/spietrza/taskcell/issues/900)) ([#902](https://github.com/spietrza/taskcell/issues/902)) ([91e99bd](https://github.com/spietrza/taskcell/commit/91e99bdf2a3e9bb0c47f8f28f49823f57deef46f))
* PR review: give the reviewer the linked issue so it can check the acceptance criteria (spietrza/taskcell[#908](https://github.com/spietrza/taskcell/issues/908)) ([#937](https://github.com/spietrza/taskcell/issues/937)) ([9c89bb6](https://github.com/spietrza/taskcell/commit/9c89bb6a05943510bc68eb0d992f4a2c4579ea45))
* PR review: the linked issue must not be chosen by the PR author (spietrza/taskcell[#938](https://github.com/spietrza/taskcell/issues/938)) ([#940](https://github.com/spietrza/taskcell/issues/940)) ([e813998](https://github.com/spietrza/taskcell/commit/e813998174658275061975b01b6618cdcbd9e262))
* Proof of work: verify must cover the desktop app like CI does (spietrza/taskcell[#922](https://github.com/spietrza/taskcell/issues/922)) ([#927](https://github.com/spietrza/taskcell/issues/927)) ([8977145](https://github.com/spietrza/taskcell/commit/89771452503c39c3e5f2545d24dec8ad9b7f8019))
* review reads issues filed by the factory's own bot; regressions are blocking ([#941](https://github.com/spietrza/taskcell/issues/941)) ([b22005f](https://github.com/spietrza/taskcell/commit/b22005fe4cc53b7328e30f21da43b7226e9e7915))
* Revise: blocking findings under a section heading are dropped (regression from [#897](https://github.com/spietrza/taskcell/issues/897)) (spietrza/taskcell[#944](https://github.com/spietrza/taskcell/issues/944)) ([#951](https://github.com/spietrza/taskcell/issues/951)) ([b689370](https://github.com/spietrza/taskcell/commit/b689370cfa4b97663d5fdde3a1d96dab831b4c1d))
* Revise: detail bullets under a finding heading are counted as separate blocking findings (spietrza/taskcell[#896](https://github.com/spietrza/taskcell/issues/896)) ([#897](https://github.com/spietrza/taskcell/issues/897)) ([c20e1e8](https://github.com/spietrza/taskcell/commit/c20e1e86e6afb88f44d33709044bafbab0a7f998))
* Secret scan: a PascalCase type annotation after auth:/token: is reported as a secret (spietrza/taskcell[#904](https://github.com/spietrza/taskcell/issues/904)) ([#905](https://github.com/spietrza/taskcell/issues/905)) ([64ca5c3](https://github.com/spietrza/taskcell/commit/64ca5c3d2f61f07a670a974f4091534dd58d4e24))
* setup guide could reopen after Dismiss ([#920](https://github.com/spietrza/taskcell/issues/920)) ([2f59391](https://github.com/spietrza/taskcell/commit/2f59391b4aa772134349778887b46b8ba243a255))


### Documentation

* add Hub UI prototype v1 as the design baseline ([#821](https://github.com/spietrza/taskcell/issues/821)) ([c88ca35](https://github.com/spietrza/taskcell/commit/c88ca35bc76920fc0ca08132e7bfc2dcec30b232))
* add Hub UI prototype v3 ([#835](https://github.com/spietrza/taskcell/issues/835)) ([6d651d2](https://github.com/spietrza/taskcell/commit/6d651d26db674507fe99f2649509072678a2f742))
* define blocking severity for the reviewer ([#861](https://github.com/spietrza/taskcell/issues/861)) ([e1c4a1b](https://github.com/spietrza/taskcell/commit/e1c4a1b1628f257d7ddf8a65cae6f01a5b6a3512))
* which model for which stage ([#926](https://github.com/spietrza/taskcell/issues/926)) ([0b7ab04](https://github.com/spietrza/taskcell/commit/0b7ab0494c9307b833f11c33efba0e0a59097e39))

## [1.15.3](https://github.com/spietrza/taskcell/compare/v1.15.2...v1.15.3) (2026-11-12)


### Features

* Enable factory: write taskcell-*.yml callers, recognise existing vanguard-*.yml (spietrza/taskcell[#802](https://github.com/spietrza/taskcell/issues/802)) ([#807](https://github.com/spietrza/taskcell/issues/807)) ([f30ad11](https://github.com/spietrza/taskcell/commit/f30ad11f3c6f2e901b5e6ca4537c177d4a7f121a))
* Factory: run one issue or one PR per invocation (watch --issue / watch-prs --pr) (spietrza/taskcell[#768](https://github.com/spietrza/taskcell/issues/768)) ([#780](https://github.com/spietrza/taskcell/issues/780)) ([c9ec4bf](https://github.com/spietrza/taskcell/commit/c9ec4bfabaec5913407a7efed1bd271e0fb852e6))
* Factory: stop at a user-set usage cap (e.g. 80% of the plan window) instead of the provider's 100% (spietrza/taskcell[#784](https://github.com/spietrza/taskcell/issues/784)) ([#794](https://github.com/spietrza/taskcell/issues/794)) ([d759913](https://github.com/spietrza/taskcell/commit/d759913158a4f8c0d292a6023aa223d61ed11bfb))
* follow-ups from the [#655](https://github.com/spietrza/taskcell/issues/655) and [#656](https://github.com/spietrza/taskcell/issues/656) reviews (spietrza/taskcell[#685](https://github.com/spietrza/taskcell/issues/685)) ([#793](https://github.com/spietrza/taskcell/issues/793)) ([91f0ba6](https://github.com/spietrza/taskcell/commit/91f0ba6b8ee3e8bf87b17f5346f91617e6a9969f))
* per-PR lessons on the metrics branch ([#765](https://github.com/spietrza/taskcell/issues/765)) ([#808](https://github.com/spietrza/taskcell/issues/808)) ([d399421](https://github.com/spietrza/taskcell/commit/d3994215f0db8294d770d6339d5d25115e914238))
* per-repo directory .taskcell/ with .vanguard/ fallback ([#803](https://github.com/spietrza/taskcell/issues/803)) ([fe11cea](https://github.com/spietrza/taskcell/commit/fe11ceadb2d8378ae21ffc05070ad342240b99b6))
* Read-only rootfs opt-in: follow-ups from [#752](https://github.com/spietrza/taskcell/issues/752) review (spietrza/taskcell[#753](https://github.com/spietrza/taskcell/issues/753)) ([#791](https://github.com/spietrza/taskcell/issues/791)) ([19da950](https://github.com/spietrza/taskcell/commit/19da950f6513fc64385cf2e9f36c8e40b450ae20))
* rename the metrics branch to taskcell-metrics (legacy fallback) ([#764](https://github.com/spietrza/taskcell/issues/764)) ([fcbda08](https://github.com/spietrza/taskcell/commit/fcbda0857c6ad861f7b8578fbdb9d9d67fc2ceaa))
* Rename: vanguard bin deprecation note and docs (spietrza/taskcell[#797](https://github.com/spietrza/taskcell/issues/797)) ([#806](https://github.com/spietrza/taskcell/issues/806)) ([72acae9](https://github.com/spietrza/taskcell/commit/72acae91156f7d5510798392b73fe0fa2da75228))
* sandbox image build fails the whole run on a transient GitHub Releases 504 (spietrza/taskcell[#657](https://github.com/spietrza/taskcell/issues/657)) ([#781](https://github.com/spietrza/taskcell/issues/781)) ([f3112dd](https://github.com/spietrza/taskcell/commit/f3112dd5a8c8f31287443a31ba07f265093323e9))
* Sandbox: host-aware memory default and OOM evidence after a failed verify (spietrza/taskcell[#771](https://github.com/spietrza/taskcell/issues/771)) ([#810](https://github.com/spietrza/taskcell/issues/810)) ([eacbad6](https://github.com/spietrza/taskcell/commit/eacbad6076c0048e3664a5c09f778cca1c6e2d4b))
* Stats: approver scorecard (shadow verdict vs what the human did) (spietrza/taskcell[#785](https://github.com/spietrza/taskcell/issues/785)) ([#790](https://github.com/spietrza/taskcell/issues/790)) ([3b7069f](https://github.com/spietrza/taskcell/commit/3b7069f156ff44f3b3e0599d642d5dc0019a61c5))
* Stats: label-to-merge lead time and revise rounds per issue (spietrza/taskcell[#737](https://github.com/spietrza/taskcell/issues/737)) ([#788](https://github.com/spietrza/taskcell/issues/788)) ([e26c3fe](https://github.com/spietrza/taskcell/commit/e26c3fe6f90c58d5bf2520d5dbde76f87571e27a))


### Bug Fixes

* bump sandbox Claude CLI to 2.1.322 ([#792](https://github.com/spietrza/taskcell/issues/792)) ([f6017c9](https://github.com/spietrza/taskcell/commit/f6017c961e7b184307d710dcc3c1075b8fbb15c5))
* **sandbox:** run an init so zombies stop filling the pids limit (exit 134) ([#809](https://github.com/spietrza/taskcell/issues/809)) ([ecd1bf7](https://github.com/spietrza/taskcell/commit/ecd1bf709595113c47e0d42ec22a0cf191834a1a))
* say taskcell in user-facing messages, docs and the desktop window ([#783](https://github.com/spietrza/taskcell/issues/783)) ([aa1694c](https://github.com/spietrza/taskcell/commit/aa1694c847005203f827fc18f62adc525d08f2c8))


### Code Refactoring

* Taskcell names for source files and identifiers ([#805](https://github.com/spietrza/taskcell/issues/805)) ([cc7f3c0](https://github.com/spietrza/taskcell/commit/cc7f3c04e284c6f343234ba2eb21c35fdce1e8f2))


### Miscellaneous

* release 1.15.3 ([c955bd7](https://github.com/spietrza/taskcell/commit/c955bd763670f431f8ac85f802ee117a312b2e2f))

## [1.15.2](https://github.com/spietrza/taskcell/compare/v1.15.1...v1.15.2) (2026-11-11)


### Features

* conformance: map every acceptance criterion to the spec manifest, incl. docs and PR-body items (spietrza/taskcell[#718](https://github.com/spietrza/taskcell/issues/718)) ([#720](https://github.com/spietrza/taskcell/issues/720)) ([2e2b9d6](https://github.com/spietrza/taskcell/commit/2e2b9d64312ff5805e72baaa87577766d7415274))
* Conformance: PR-body obligations as one delivery verdict (spietrza/taskcell[#757](https://github.com/spietrza/taskcell/issues/757)) ([#759](https://github.com/spietrza/taskcell/issues/759)) ([6084059](https://github.com/spietrza/taskcell/commit/6084059e33b249ca95b901267db99b4d25d1205a))
* Copy-back: one module owns what leaves the sandbox (spietrza/taskcell[#754](https://github.com/spietrza/taskcell/issues/754)) ([#762](https://github.com/spietrza/taskcell/issues/762)) ([44790f1](https://github.com/spietrza/taskcell/commit/44790f1d471b4e148d44b9971767e3de1f434f34))
* hub: Enable factory on the platform the user picks (GitHub Actions first; GitLab, Linear next) (spietrza/taskcell[#721](https://github.com/spietrza/taskcell/issues/721)) ([#726](https://github.com/spietrza/taskcell/issues/726)) ([3e444eb](https://github.com/spietrza/taskcell/commit/3e444eb4b54d50f9bba2adf556cf87551d3b9a59))
* hub: queue runs instead of rejecting a second one (spietrza/taskcell[#618](https://github.com/spietrza/taskcell/issues/618)) ([#728](https://github.com/spietrza/taskcell/issues/728)) ([2164dd6](https://github.com/spietrza/taskcell/commit/2164dd6abb0c09901e5af22dcf420dce66a71e65))
* Hub: shared timestamps, status words and error text (spietrza/taskcell[#741](https://github.com/spietrza/taskcell/issues/741)) ([#742](https://github.com/spietrza/taskcell/issues/742)) ([93b1569](https://github.com/spietrza/taskcell/commit/93b15695634f8572d1a61b5c78760562045d2bab))
* hub: show what the factory is asking and reply from the hub (spietrza/taskcell[#722](https://github.com/spietrza/taskcell/issues/722)) ([#727](https://github.com/spietrza/taskcell/issues/727)) ([bf41a0a](https://github.com/spietrza/taskcell/commit/bf41a0ae28a3fbfacda3eb8995285cbaa461b7a0))
* **hub:** Enable factory button and plan dialog ([#739](https://github.com/spietrza/taskcell/issues/739)) ([6c04833](https://github.com/spietrza/taskcell/commit/6c048335835b5971592ed250850bd5c10a6db772))
* **hub:** landing visual identity (dark, amber, landing fonts) ([#744](https://github.com/spietrza/taskcell/issues/744)) ([1f7300f](https://github.com/spietrza/taskcell/commit/1f7300f8d588fbc07f8c6a41363a0784e0e13459))
* Sandbox: contract test suite on the real image (spietrza/taskcell[#756](https://github.com/spietrza/taskcell/issues/756)) ([#758](https://github.com/spietrza/taskcell/issues/758)) ([15cf067](https://github.com/spietrza/taskcell/commit/15cf067f3aa2c83097ac599e698a0b7315221877))
* Sandbox: decide the sandbox profile once (spietrza/taskcell[#755](https://github.com/spietrza/taskcell/issues/755)) ([#767](https://github.com/spietrza/taskcell/issues/767)) ([87abf5f](https://github.com/spietrza/taskcell/commit/87abf5f8bceea015491bf88096634a5a5c104c17))
* sandbox: read-only rootfs, opt-in with `VANGUARD_SANDBOX_READONLY=1` (spietrza/taskcell[#717](https://github.com/spietrza/taskcell/issues/717)) ([#725](https://github.com/spietrza/taskcell/issues/725)) ([3b438a8](https://github.com/spietrza/taskcell/commit/3b438a8184987f4b2e0161eebe02176750f45d8d))


### Bug Fixes

* **copy-back:** skip the pnpm store a read-only sandbox puts in the workspace ([#748](https://github.com/spietrza/taskcell/issues/748)) ([c34f711](https://github.com/spietrza/taskcell/commit/c34f711902c2f56800f7212d89971ac4bab94432))
* **eval:** retry a hung model call instead of failing the baseline ([#763](https://github.com/spietrza/taskcell/issues/763)) ([4fe6c90](https://github.com/spietrza/taskcell/commit/4fe6c90037c34f1a8135c5bbebf43b63be180e13))
* **eval:** tell the tool-less model it has no tools; name the case in progress and timeouts ([#766](https://github.com/spietrza/taskcell/issues/766)) ([8856702](https://github.com/spietrza/taskcell/commit/88567028371a96033e5cf309423584d2b8e8ad70))
* **hub:** demo QA fixes (title bar, queued strip, enable-factory plan, needs-you) ([#743](https://github.com/spietrza/taskcell/issues/743)) ([66415ea](https://github.com/spietrza/taskcell/commit/66415ea962df4ed2f201c6c0525d40c52cd40499))
* release review follow-ups (copy-back robustness, enable-factory apply guards) ([#750](https://github.com/spietrza/taskcell/issues/750)) ([80d944e](https://github.com/spietrza/taskcell/commit/80d944e56c4a978bb5df84dd559d792d89df6871))
* **sandbox:** copy in/out via docker exec under read-only rootfs ([#745](https://github.com/spietrza/taskcell/issues/745)) ([4e797a0](https://github.com/spietrza/taskcell/commit/4e797a020fb5549796c92d1a6a765b0b71ec4d0f))
* **sandbox:** give tmpfs workspace and home to the run user under read-only rootfs ([#746](https://github.com/spietrza/taskcell/issues/746)) ([1d64392](https://github.com/spietrza/taskcell/commit/1d64392caf6645e293663feefe62440b2e450ec2))
* **sandbox:** make the read-only rootfs opt-in (VANGUARD_SANDBOX_READONLY=1) ([#752](https://github.com/spietrza/taskcell/issues/752)) ([829b9b6](https://github.com/spietrza/taskcell/commit/829b9b6a6c1d8dae66e1734539f554fa89ca9b61))
* **sandbox:** stream copy-in/out without execa's 100 MB buffer ([#747](https://github.com/spietrza/taskcell/issues/747)) ([a156b04](https://github.com/spietrza/taskcell/commit/a156b048229bb292b31af3413f0046beee100119))


### Documentation

* bring docs up to date for 1.15.2 ([#770](https://github.com/spietrza/taskcell/issues/770)) ([f4d217a](https://github.com/spietrza/taskcell/commit/f4d217ae3baab21d524329dd8a41141ec83a8ce8))
* **hub:** design baseline, audit and fixes ([#740](https://github.com/spietrza/taskcell/issues/740)) ([025074d](https://github.com/spietrza/taskcell/commit/025074d507012fe97d286e2a18dd798c8bb891df))

## [1.15.1](https://github.com/spietrza/taskcell/compare/v1.15.0...v1.15.1) (2026-11-10)


### Features

* eval: compare with main's baseline and gate PRs on a regression (spietrza/taskcell[#706](https://github.com/spietrza/taskcell/issues/706)) ([#713](https://github.com/spietrza/taskcell/issues/713)) ([de2322d](https://github.com/spietrza/taskcell/commit/de2322d1e79214a8b392374058e619ff9addfba2))
* eval: turn human-rejected factory runs into draft corpus candidates (spietrza/taskcell[#707](https://github.com/spietrza/taskcell/issues/707)) ([#712](https://github.com/spietrza/taskcell/issues/712)) ([e3cb2bb](https://github.com/spietrza/taskcell/commit/e3cb2bb6532e370d5e0aab4bb610bbe0441ddaa2))
* tests: three tests fail on macOS (/private/var temp paths) (spietrza/taskcell[#668](https://github.com/spietrza/taskcell/issues/668)) ([#710](https://github.com/spietrza/taskcell/issues/710)) ([f674bc4](https://github.com/spietrza/taskcell/commit/f674bc4ca4fe3c5dacbcd39404c2f36ad8021baf))


### Bug Fixes

* **deps:** desktop dependency bumps and pnpm/action-setup 6.1.1 ([#719](https://github.com/spietrza/taskcell/issues/719)) ([4662d08](https://github.com/spietrza/taskcell/commit/4662d08555ac1da4776257766019c6b78c776a4f))
* **evals:** also accept the safeguards-flagged stop as an answer ([#732](https://github.com/spietrza/taskcell/issues/732)) ([db344d3](https://github.com/spietrza/taskcell/commit/db344d38f90cb57886f6974245fbacb51ba5f81d))
* **evals:** retry the judge once on an invalid verdict instead of aborting the run ([#723](https://github.com/spietrza/taskcell/issues/723)) ([3766754](https://github.com/spietrza/taskcell/commit/3766754f9ea6e16a3c483a6e66f597e4d3ba9775))
* **evals:** run eval model calls without tools, MCP or the repo as cwd ([#729](https://github.com/spietrza/taskcell/issues/729)) ([d52df53](https://github.com/spietrza/taskcell/commit/d52df532bd58a59395618c7958aaa0dd52764443))
* **evals:** send a stand-in prompt for the empty-input case ([#724](https://github.com/spietrza/taskcell/issues/724)) ([0c41ab4](https://github.com/spietrza/taskcell/commit/0c41ab41244b6f80d7ec96d6fd13661ef70d8db7))
* **evals:** show partial CLI output when a model call times out ([#734](https://github.com/spietrza/taskcell/issues/734)) ([7e9260a](https://github.com/spietrza/taskcell/commit/7e9260a1d534cf69be6579076f91bc48f2fb56d2))
* **evals:** time out a hung model call after 5 minutes ([#733](https://github.com/spietrza/taskcell/issues/733)) ([1618d95](https://github.com/spietrza/taskcell/commit/1618d9550cbd6ba751b8955830bdd0387a5ffbc5))
* **evals:** treat an API safety stop as the model's answer ([#731](https://github.com/spietrza/taskcell/issues/731)) ([fc7194b](https://github.com/spietrza/taskcell/commit/fc7194bf90d5f9cbf5eab563b88c5d36d2f8382c))
* factory workflows pull the prebuilt sandbox image ([#711](https://github.com/spietrza/taskcell/issues/711)) ([192cdfe](https://github.com/spietrza/taskcell/commit/192cdfe61d0c1ecae81c1dcf6e111795461b4c7f))


### Documentation

* evals and guardrails self-assessment ([#708](https://github.com/spietrza/taskcell/issues/708)) ([8a8efad](https://github.com/spietrza/taskcell/commit/8a8efad0a70cbc0c380c6317316fbbbf9e55a59d))


### Miscellaneous

* release 1.15.1 ([#714](https://github.com/spietrza/taskcell/issues/714)) ([79e6ce0](https://github.com/spietrza/taskcell/commit/79e6ce06ea24dd2c2db7ae95db752da5493af0af))

## [1.15.0](https://github.com/spietrza/taskcell/compare/v1.14.0...v1.15.0) (2026-11-10)


### Features

* in-pipeline reviewer: no pass by default, re-review after repairs, report-only (spietrza/taskcell[#673](https://github.com/spietrza/taskcell/issues/673)) ([#700](https://github.com/spietrza/taskcell/issues/700)) ([32ad52b](https://github.com/spietrza/taskcell/commit/32ad52b0bb1d59ce3f114f05b19a808a57f3d25e))
* prebuilt sandbox image on GHCR, pull-first in all factory runs (spietrza/taskcell[#674](https://github.com/spietrza/taskcell/issues/674)) ([#702](https://github.com/spietrza/taskcell/issues/702)) ([739e1b8](https://github.com/spietrza/taskcell/commit/739e1b8730ca63fc70847c171fdae57b628fb9b4))
* repair-gate: drop the dead iterations decrement in the provider-limit catch (spietrza/taskcell[#691](https://github.com/spietrza/taskcell/issues/691)) ([#692](https://github.com/spietrza/taskcell/issues/692)) ([75d740b](https://github.com/spietrza/taskcell/commit/75d740b5c37cd31e945fcb7f792cbc18e175d8c7))
* revise: a fresh human request after the round cap starts a new budget (spietrza/taskcell[#675](https://github.com/spietrza/taskcell/issues/675)) ([#701](https://github.com/spietrza/taskcell/issues/701)) ([e02824b](https://github.com/spietrza/taskcell/commit/e02824bdeb94034e52a7ecf0e727d23e2a762eb3))
* sandbox: opt-in persistent pnpm store per repo, so installs stop re-downloading (spietrza/taskcell[#695](https://github.com/spietrza/taskcell/issues/695)) ([#703](https://github.com/spietrza/taskcell/issues/703)) ([dac316b](https://github.com/spietrza/taskcell/commit/dac316b422bd48ce926044fde6e777604ffdf3af))


### Bug Fixes

* **landing:** scene labels, pause control, WebGL fallback ([#699](https://github.com/spietrza/taskcell/issues/699)) ([6bfdbcf](https://github.com/spietrza/taskcell/commit/6bfdbcfd8c49ca10cece135f95e3ef1e98349c2b))
* redact the provider-limit log line in repair-gate ([#698](https://github.com/spietrza/taskcell/issues/698)) ([9bf4437](https://github.com/spietrza/taskcell/commit/9bf4437a6b26f09c9d927aac768c4268b9499c95))


### Documentation

* Taskcell banner, social preview and icon ([#696](https://github.com/spietrza/taskcell/issues/696)) ([7495195](https://github.com/spietrza/taskcell/commit/7495195cbc2b0524dbb5edfef9e56eeacfea8f61))

## [1.14.0](https://github.com/spietrza/taskcell/compare/v1.13.0...v1.14.0) (2026-11-09)


### Features

* 429 handling: match usage-limit and overload wordings, keep --review-model on fallback (spietrza/taskcell[#640](https://github.com/spietrza/taskcell/issues/640)) ([#656](https://github.com/spietrza/taskcell/issues/656)) ([64b64b8](https://github.com/spietrza/taskcell/commit/64b64b82661f259ea5460811d45792547577527b))
* auto-resume factory work after a provider rate or session limit (spietrza/taskcell[#682](https://github.com/spietrza/taskcell/issues/682)) ([#684](https://github.com/spietrza/taskcell/issues/684)) ([1871c8e](https://github.com/spietrza/taskcell/commit/1871c8eb100f4c54c33d88601f1aeebdd89057e7))
* Codex ChatGPT plan, part 1: sidecar auth (account id, refresh/revoke binding, refresh floor) (spietrza/taskcell[#652](https://github.com/spietrza/taskcell/issues/652)) ([#658](https://github.com/spietrza/taskcell/issues/658)) ([14b8d26](https://github.com/spietrza/taskcell/commit/14b8d26da1582c5d2314c858ce939f9deeb9accb))
* Codex ChatGPT plan, part 2: placeholder auth.json in the cell, warnings and docs (spietrza/taskcell[#653](https://github.com/spietrza/taskcell/issues/653)) ([#670](https://github.com/spietrza/taskcell/issues/670)) ([7c81ce7](https://github.com/spietrza/taskcell/commit/7c81ce7f4211c18103408934bf136288098449ac))
* codex sidecar: no redirects on IdP calls, refresh floor/backoff/cap, rotation warning (spietrza/taskcell[#672](https://github.com/spietrza/taskcell/issues/672)) ([#679](https://github.com/spietrza/taskcell/issues/679)) ([6fad262](https://github.com/spietrza/taskcell/commit/6fad2623e970f51e51bf0f708f2229bcaaa215fe))
* Gate red on base branch burns repair loops and widens scope (AW [#2024](https://github.com/spietrza/taskcell/issues/2024): 1-line fix ended incomplete twice) (spietrza/taskcell[#651](https://github.com/spietrza/taskcell/issues/651)) ([#655](https://github.com/spietrza/taskcell/issues/655)) ([e8cb7af](https://github.com/spietrza/taskcell/commit/e8cb7af7a12000089051a41b224b36362263ef2f))
* Gate-config signal: reliability follow-ups from [#641](https://github.com/spietrza/taskcell/issues/641) (spietrza/taskcell[#643](https://github.com/spietrza/taskcell/issues/643)) ([#654](https://github.com/spietrza/taskcell/issues/654)) ([29bd75b](https://github.com/spietrza/taskcell/commit/29bd75b5b145f103fe7fc59b56749a56d40e9ec8))
* gate: ratchet coverage thresholds up to the current baseline (spietrza/taskcell[#628](https://github.com/spietrza/taskcell/issues/628)) ([#662](https://github.com/spietrza/taskcell/issues/662)) ([12a9bb4](https://github.com/spietrza/taskcell/commit/12a9bb48a86973bcf408e1070d16589421a0350c))
* in-pipeline review: an empty or aborted reply is incomplete, not pass (spietrza/taskcell[#678](https://github.com/spietrza/taskcell/issues/678)) ([#681](https://github.com/spietrza/taskcell/issues/681)) ([35f9a26](https://github.com/spietrza/taskcell/commit/35f9a268297755a289a984bcd8d0c7446a56184d))
* revise-pr: --provider-model so revise rounds use the same model as implement (spietrza/taskcell[#664](https://github.com/spietrza/taskcell/issues/664)) ([#665](https://github.com/spietrza/taskcell/issues/665)) ([09d8047](https://github.com/spietrza/taskcell/commit/09d8047dd757bd47e54bd92b9e2a701b9502f4e8))
* sandbox image: pin pnpm and bun to exact versions (spietrza/taskcell[#666](https://github.com/spietrza/taskcell/issues/666)) ([#676](https://github.com/spietrza/taskcell/issues/676)) ([b1f0ff2](https://github.com/spietrza/taskcell/commit/b1f0ff25f0a62303c6c0262b32eb7174587839b7))


### Bug Fixes

* **sandbox:** don't fail the image build when linear-cli can't download ([#661](https://github.com/spietrza/taskcell/issues/661)) ([3f68818](https://github.com/spietrza/taskcell/commit/3f68818c9701f0059c1a5cbea7dc650d5e3dec3f))
* **sandbox:** retry global npm install on transient download errors ([#659](https://github.com/spietrza/taskcell/issues/659)) ([664ce2c](https://github.com/spietrza/taskcell/commit/664ce2c88e6dfdf7046313db27f02fcbc852a234))

## [1.13.0](https://github.com/spietrza/taskcell/compare/v1.12.0...v1.13.0) (2026-11-07)


### Features

* **desktop:** desktop: list_runs/read_run forward to core run-store over the sidecar pipe; delete the runs.rs reader (spietrza/taskcell[#511](https://github.com/spietrza/taskcell/issues/511)) ([#614](https://github.com/spietrza/taskcell/issues/614)) ([82fcea4](https://github.com/spietrza/taskcell/commit/82fcea465e48f55fbc76a8de3dfe2e75c1e2dae2))
* **desktop:** review verdict as a run record; Task Board shows the pipeline stage and per-stage verdict chips (spietrza/taskcell[#512](https://github.com/spietrza/taskcell/issues/512)) ([#613](https://github.com/spietrza/taskcell/issues/613)) ([d0710f8](https://github.com/spietrza/taskcell/commit/d0710f82a70144ef65713a9bd3e3031cf8080e30))
* Factory runs that hit a provider rate limit (429) stay stuck until someone re-labels the PR (spietrza/taskcell[#615](https://github.com/spietrza/taskcell/issues/615)) ([#639](https://github.com/spietrza/taskcell/issues/639)) ([50d7b7e](https://github.com/spietrza/taskcell/commit/50d7b7ef96298b03608322bcd9270e958c0d4757))
* gate: flag and human-gate factory changes to checker config (spietrza/taskcell[#627](https://github.com/spietrza/taskcell/issues/627)) ([#641](https://github.com/spietrza/taskcell/issues/641)) ([fdf2780](https://github.com/spietrza/taskcell/commit/fdf2780aaacdb39a430bea8791d2cddbb9bb7531))
* hub: always run with the LLM proxy (spietrza/vanguard[#584](https://github.com/spietrza/taskcell/issues/584)) ([#587](https://github.com/spietrza/taskcell/issues/587)) ([dde684b](https://github.com/spietrza/taskcell/commit/dde684b5065ccacf39d398f398c28c369cb1457b))
* hub: Host allowlist and per-launch token (DNS rebinding) (spietrza/vanguard[#583](https://github.com/spietrza/taskcell/issues/583)) ([#588](https://github.com/spietrza/taskcell/issues/588)) ([a083269](https://github.com/spietrza/taskcell/commit/a0832699326d44b8d37d4ab4b688c70278248323))
* hub: Host allowlist follow-ups (port-forward, --host, SSE wording, docs) (spietrza/vanguard[#591](https://github.com/spietrza/taskcell/issues/591)) ([#594](https://github.com/spietrza/taskcell/issues/594)) ([552830a](https://github.com/spietrza/taskcell/commit/552830aea99ed21448bd7035eac3612b029a086b))
* hub: watch.test.ts T-72/T-73 fail on macOS (fs.watch timing), pass on Linux CI (spietrza/taskcell[#528](https://github.com/spietrza/taskcell/issues/528)) ([#612](https://github.com/spietrza/taskcell/issues/612)) ([0ee1f6a](https://github.com/spietrza/taskcell/commit/0ee1f6a51a4311419db0566180729139607de74b))
* landing: remove the PR counter and fix spacing, scene labels and touch targets from the design review (spietrza/taskcell[#624](https://github.com/spietrza/taskcell/issues/624)) ([#626](https://github.com/spietrza/taskcell/issues/626)) ([b2ebb34](https://github.com/spietrza/taskcell/commit/b2ebb34c9d57de1b92a17e6d70d233e67d177962))
* PR reviewer ends without a verdict despite spending tokens (spietrza/taskcell[#598](https://github.com/spietrza/taskcell/issues/598)) ([#609](https://github.com/spietrza/taskcell/issues/609)) ([2b28883](https://github.com/spietrza/taskcell/commit/2b288835968ebe4ccef112b500335fdfcc015b32))
* Rename what users see from Vanguard to Taskcell (CLI, Hub, image, docs) (spietrza/taskcell[#646](https://github.com/spietrza/taskcell/issues/646)) ([#648](https://github.com/spietrza/taskcell/issues/648)) ([3cc1b15](https://github.com/spietrza/taskcell/commit/3cc1b15a60ebc9d04d4b652dc2bfa8675cb570fb))
* Rename what users see from Vanguard to Taskcell (CLI, Hub, image, docs) (spietrza/taskcell[#646](https://github.com/spietrza/taskcell/issues/646)) ([#650](https://github.com/spietrza/taskcell/issues/650)) ([5fb7412](https://github.com/spietrza/taskcell/commit/5fb74123c40df9b22c5794016a395cb9c64fb7c6))
* **runners:** PR review worktree is cut from the PR's base branch, so reviewer instruction files (CLAUDE.md, AGENTS.md, skills/) come from that branch (spietrza/taskcell[#463](https://github.com/spietrza/taskcell/issues/463)) ([#610](https://github.com/spietrza/taskcell/issues/610)) ([666dec9](https://github.com/spietrza/taskcell/commit/666dec91615740b6f5ce1afb10e25703284d2252))
* secret-scan: bearer rule flags prose like "bearer token" (spietrza/taskcell[#635](https://github.com/spietrza/taskcell/issues/635)) ([#637](https://github.com/spietrza/taskcell/issues/637)) ([e986fd0](https://github.com/spietrza/taskcell/commit/e986fd0cc5c110180ad19be79bf1d3e9690cf42c))
* sidecar: LLM-proxy follow-ups (real credential test, docs scope, warning dedup) (spietrza/taskcell[#592](https://github.com/spietrza/taskcell/issues/592)) ([#611](https://github.com/spietrza/taskcell/issues/611)) ([8843eef](https://github.com/spietrza/taskcell/commit/8843eefc96e9030f9789260ad84feb54ca5941f8))
* sidecar: LLM-proxy follow-ups (real credential test, docs scope, warning dedup) (spietrza/vanguard[#592](https://github.com/spietrza/taskcell/issues/592)) ([#593](https://github.com/spietrza/taskcell/issues/593)) ([c163f37](https://github.com/spietrza/taskcell/commit/c163f379878e318d2af29f282c3f4d2f057bdb31))
* spike: can the Codex ChatGPT-plan credential stay on the host behind the LLM proxy (spietrza/taskcell[#625](https://github.com/spietrza/taskcell/issues/625)) ([#638](https://github.com/spietrza/taskcell/issues/638)) ([2df156a](https://github.com/spietrza/taskcell/commit/2df156a982921b0ffad1d9782a217e14403455c2))


### Bug Fixes

* argv spawn for desktop runs and chat origin allowlist ([#600](https://github.com/spietrza/taskcell/issues/600)) ([5fe4dea](https://github.com/spietrza/taskcell/commit/5fe4dea6ac61f1398e9f4b1bfa33fbb7f2298f5d))
* harden hub endpoints ([#605](https://github.com/spietrza/taskcell/issues/605)) ([983029b](https://github.com/spietrza/taskcell/commit/983029b9ce50113956afe91e9b8595150ace68a4))
* harden prompt context and trust checks ([#608](https://github.com/spietrza/taskcell/issues/608)) ([aa3adfc](https://github.com/spietrza/taskcell/commit/aa3adfcef6c6fc1da90e4643a1f293790182695e))
* harden sandbox egress and delivery ([#607](https://github.com/spietrza/taskcell/issues/607)) ([62f76c1](https://github.com/spietrza/taskcell/commit/62f76c172ba5a4d95f5cc7d4044a40c1274030a5))
* ignore worktree hooks in host git ([#596](https://github.com/spietrza/taskcell/issues/596)) ([39a3fe7](https://github.com/spietrza/taskcell/commit/39a3fe710269354af1586f6f8f9442876285a9d4))
* pass hub token via launch url ([#597](https://github.com/spietrza/taskcell/issues/597)) ([40204e6](https://github.com/spietrza/taskcell/commit/40204e6b17e82aeef731a483b3ee09ab69c27a3e))
* redact injected secrets on every publish path ([#602](https://github.com/spietrza/taskcell/issues/602)) ([2204948](https://github.com/spietrza/taskcell/commit/2204948e10fc5f06725e467a2487dcbe3b60a7b7))
* **secret-scan:** don't block a placeholder name after Authorization: Bearer ([#647](https://github.com/spietrza/taskcell/issues/647)) ([f871781](https://github.com/spietrza/taskcell/commit/f87178193c942d46def8d60e452177cbc0b8caac))
* tighten tracker comment trust and board scope ([#599](https://github.com/spietrza/taskcell/issues/599)) ([6b0383d](https://github.com/spietrza/taskcell/commit/6b0383d00558d29a3ef99331744224e80a75f9e8))
* validate session ids and guard .vanguard paths ([#601](https://github.com/spietrza/taskcell/issues/601)) ([e94c778](https://github.com/spietrza/taskcell/commit/e94c7787aa23ce3c03696e85ff2e496c8a5873d8))


### Documentation

* add security policy ([#590](https://github.com/spietrza/taskcell/issues/590)) ([23c886f](https://github.com/spietrza/taskcell/commit/23c886fe7b5cf04873fc2f3980d8b1e985f7f21c))
* product README and OWASP self-assessment ([#606](https://github.com/spietrza/taskcell/issues/606)) ([230d9f4](https://github.com/spietrza/taskcell/commit/230d9f4278e844cd41b838fdc2b39f682ae138de))
* rename repo to spietrza/taskcell ([#595](https://github.com/spietrza/taskcell/issues/595)) ([504affe](https://github.com/spietrza/taskcell/commit/504affee1b941c9e378c97acaa2e8d949b0890f5))
* self-hosted security review ([#582](https://github.com/spietrza/taskcell/issues/582)) ([408b751](https://github.com/spietrza/taskcell/commit/408b75191c59ec5c64fa01c8ecbf369b5dfbf57e))

## [1.12.0](https://github.com/spietrza/vanguard/compare/v1.11.0...v1.12.0) (2026-10-24)


### Features

* **approver:** deterministic APPROVE/ESCALATE for factory PRs, shadow mode ([#557](https://github.com/spietrza/vanguard/issues/557)) ([44196c5](https://github.com/spietrza/vanguard/commit/44196c50d0bd5464763ab8bf448122848fcea529))
* **approver:** the `Vanguard Approver (shadow)` workflow runs the approver after the factory PR review and comments APPROVE/ESCALATE; it never merges, approves or labels ([#564](https://github.com/spietrza/vanguard/issues/564)) ([b4fca07](https://github.com/spietrza/vanguard/commit/b4fca07eb2a7268fc6ecd94526fb8343932d57a2))
* **hub:** show how many tasks wait for the factory (spietrza/vanguard[#560](https://github.com/spietrza/vanguard/issues/560)) ([#562](https://github.com/spietrza/vanguard/issues/562)) ([ed440ef](https://github.com/spietrza/vanguard/commit/ed440efd2be76111f4052f6602ae082a1a6887d0))
* **review:** risk level line after the review verdict (spietrza/vanguard[#559](https://github.com/spietrza/vanguard/issues/559)) ([#561](https://github.com/spietrza/vanguard/issues/561)) ([340425a](https://github.com/spietrza/vanguard/commit/340425a695339c722b786517a8325f49ca11fcd8))
* revise: refuse fork PRs instead of pushing to a same-named base-repo branch (spietrza/vanguard[#567](https://github.com/spietrza/vanguard/issues/567)) ([#571](https://github.com/spietrza/vanguard/issues/571)) ([c889c81](https://github.com/spietrza/vanguard/commit/c889c81823b061aa08b1b8005f23ebbe135c23f7))
* revise: trust PR feedback and spec manifests only from authorised authors (spietrza/vanguard[#566](https://github.com/spietrza/vanguard/issues/566)) ([#569](https://github.com/spietrza/vanguard/issues/569)) ([bc92f5f](https://github.com/spietrza/vanguard/commit/bc92f5f32cfe23e799f624fc182d9e554f894133))
* secret-scan: check injected secret values regardless of path or allowlist marker (spietrza/vanguard[#568](https://github.com/spietrza/vanguard/issues/568)) ([#570](https://github.com/spietrza/vanguard/issues/570)) ([18b69c5](https://github.com/spietrza/vanguard/commit/18b69c599105c0df317152ebe0d890a32d8bc2ff))


### Bug Fixes

* **factory:** no double conventional prefix in the factory commit headline ([#553](https://github.com/spietrza/vanguard/issues/553)) ([d4ef178](https://github.com/spietrza/vanguard/commit/d4ef1780bae93534695d3d8caf9cf3430e503729))
* **revise:** mark the PR ready with VANGUARD_PUSH_TOKEN so the automatic review runs ([#572](https://github.com/spietrza/vanguard/issues/572)) ([0b30b77](https://github.com/spietrza/vanguard/commit/0b30b776d574c999a0ec79c6ddc20449b77d9336))


### Documentation

* diagrams show the shadow approver ([#565](https://github.com/spietrza/vanguard/issues/565)) ([f54ee87](https://github.com/spietrza/vanguard/commit/f54ee871047b1b105b28919efea16e8978bf00ee))
* PR review also fires on ready factory PRs ([#558](https://github.com/spietrza/vanguard/issues/558)) ([7a9def2](https://github.com/spietrza/vanguard/commit/7a9def29cb75e5c83393c72a178209e287d12058))
* README hero flow as a diagram ([#554](https://github.com/spietrza/vanguard/issues/554)) ([d7b1b8a](https://github.com/spietrza/vanguard/commit/d7b1b8ac7b5a233d8c4315240e5a0d807307b374))

## [1.11.0](https://github.com/spietrza/vanguard/compare/v1.10.1...v1.11.0) (2026-10-22)


### Features

* **decision-model:** default to clef instead of clef-flash ([#541](https://github.com/spietrza/vanguard/issues/541)) ([024cefe](https://github.com/spietrza/vanguard/commit/024cefead604baad844cb566ac0f637b7008522c))
* **factory:** open the PR ready for review when every gate passed ([#549](https://github.com/spietrza/vanguard/issues/549)) ([dcf0334](https://github.com/spietrza/vanguard/commit/dcf03341904f224240d189833e8fac7020523c4d))
* **pr-review:** `watch-prs` also takes the PR from `opened` / `ready_for_review` events, so a caller can review a factory PR as soon as it is ready; Vanguard's own caller now does that without a label, and CI's `build` runs `pnpm verify` ([#550](https://github.com/spietrza/vanguard/issues/550)) ([8e1e412](https://github.com/spietrza/vanguard/commit/8e1e412ffb3e9f413fb22f5db24c9139b897ff8e))
* **verify:** run the repo's verify script so the gate matches CI ([#548](https://github.com/spietrza/vanguard/issues/548)) ([21d81d0](https://github.com/spietrza/vanguard/commit/21d81d03644f0cbf5cace9f273daadd74cc57bf4))


### Bug Fixes

* **ci:** gate on spietrza, open factory PRs with the push token ([#543](https://github.com/spietrza/vanguard/issues/543)) ([7755fa8](https://github.com/spietrza/vanguard/commit/7755fa810f92f012b02e22b0b74a67717834fefc))
* **deps:** bump vite from 7.3.6 to 7.3.7 in apps/desktop ([#544](https://github.com/spietrza/vanguard/issues/544)) ([5443487](https://github.com/spietrza/vanguard/commit/5443487ad16d0735e855675ad132240f8d596667))


### Documentation

* add flow diagrams to README ([#542](https://github.com/spietrza/vanguard/issues/542)) ([6663df3](https://github.com/spietrza/vanguard/commit/6663df36cf0e788a652eae6922fe4246ea49e072))
* **cursor:** GitHub Actions does not support cursor yet ([#539](https://github.com/spietrza/vanguard/issues/539)) ([05e6a46](https://github.com/spietrza/vanguard/commit/05e6a46944064dd8cb5feaa008b515e8227570ca))
* diagrams cover GitLab and Linear, not just GitHub ([#545](https://github.com/spietrza/vanguard/issues/545)) ([bb7cfa0](https://github.com/spietrza/vanguard/commit/bb7cfa010026381cdaaf0aba62a22c684a2213d3))
* diagrams show ready PRs and the automatic review ([#551](https://github.com/spietrza/vanguard/issues/551)) ([1d0e5dd](https://github.com/spietrza/vanguard/commit/1d0e5ddfddbc5e17eefb6d3dc90f4536baaccd2c))


### Upgrade notes (callers on `@v1`)

* **Ready PRs:** a factory PR now opens ready for review when every gate passed. It stays a draft only when a gate or the visual proof failed, or no verify command ran ([#549](https://github.com/spietrza/vanguard/issues/549)).
* **CI on factory PRs:** map `VANGUARD_PUSH_TOKEN` in your implement caller's `secrets:`, with Contents and Pull requests: Read and write. Without it nothing changes: the PR opens with `GITHUB_TOKEN` and gets no CI until a push ([#543](https://github.com/spietrza/vanguard/issues/543)).
* **`verify` script:** a `verify` script in your `package.json` now takes precedence over the typecheck/test auto-detect ([#548](https://github.com/spietrza/vanguard/issues/548)).
* **Repository name:** the repository is `spietrza/vanguard`. Change `uses: SebaBoler/vanguard/...` to `uses: spietrza/vanguard/...`, because the old owner name only resolves through GitHub's rename redirect ([#543](https://github.com/spietrza/vanguard/issues/543)).

## [1.10.1](https://github.com/SebaBoler/vanguard/compare/v1.10.0...v1.10.1) (2026-10-20)


### Bug Fixes

* **ci:** pass bundled skills to review and revise runs ([#538](https://github.com/SebaBoler/vanguard/issues/538)) ([c4f21a6](https://github.com/SebaBoler/vanguard/commit/c4f21a69fa69d95f38cbe2ee6f0105b363285af8))


### Documentation

* **hub:** README Hub section, prerequisites and usage paths; docs/refactor in the changelog ([#536](https://github.com/SebaBoler/vanguard/issues/536)) ([4b2d172](https://github.com/SebaBoler/vanguard/commit/4b2d1724b6ce36a68111512cc03d9e5b222f60d8))

## [1.10.0](https://github.com/SebaBoler/vanguard/compare/v1.9.0...v1.10.0) (2026-10-20)


### Features

* **hub:** Add project by repository URL — clone into a chosen folder, then register it ([#534](https://github.com/SebaBoler/vanguard/issues/534)) ([440a27c](https://github.com/SebaBoler/vanguard/commit/440a27c3ca79995311f1263bbbeb35ed92b1e440)), closes [#532](https://github.com/SebaBoler/vanguard/issues/532)

## [1.9.0](https://github.com/SebaBoler/vanguard/compare/v1.8.1...v1.9.0) (2026-10-19)


### Features

* **cursor:** make the Cursor CLI provider work in the factory ([#519](https://github.com/SebaBoler/vanguard/issues/519)) ([16c2cec](https://github.com/SebaBoler/vanguard/commit/16c2cec1cfecbabfdfa52374824258b1e1919bdf))


### Bug Fixes

* **skills:** keep tech-spec out of implement, revise and review runs ([#526](https://github.com/SebaBoler/vanguard/issues/526)) ([56899cc](https://github.com/SebaBoler/vanguard/commit/56899cc9df7b1733fec7bb9fe0b5df1c9a1c0d0e))
* **skills:** warn on a dropped repo tech-spec, no override noise ([#531](https://github.com/SebaBoler/vanguard/issues/531)) ([9fbc5c6](https://github.com/SebaBoler/vanguard/commit/9fbc5c68b6e5cf113991152357112062d5eb06bd))

## [1.8.1](https://github.com/SebaBoler/vanguard/compare/v1.8.0...v1.8.1) (2026-10-19)


### Bug Fixes

* **deps:** dependabot bumps for root and apps/desktop in one verified PR ([#527](https://github.com/SebaBoler/vanguard/issues/527)) ([a11ced6](https://github.com/SebaBoler/vanguard/commit/a11ced6036e0206c1444bd3437d0e4e023604ee9))

## [1.8.0](https://github.com/SebaBoler/vanguard/compare/v1.7.0...v1.8.0) (2026-10-18)


### Features

* **desktop:** typed command catalogue in src/wire.ts for the Tauri, hub and mock adapters ([#509](https://github.com/SebaBoler/vanguard/issues/509)) ([63d5c67](https://github.com/SebaBoler/vanguard/commit/63d5c67a720e54b63bd855cb5b5b56f7fcc5c0ce)), closes [#498](https://github.com/SebaBoler/vanguard/issues/498)
* **factory:** conventional-commit prefix on factory PR titles ([#502](https://github.com/SebaBoler/vanguard/issues/502)) ([212e135](https://github.com/SebaBoler/vanguard/commit/212e1355ed43556dbc2ebb513b2ffaf13850b735)), closes [#495](https://github.com/SebaBoler/vanguard/issues/495)
* **hub:** one wire codec for the RPC envelope, SSE frames and the hub marker ([#503](https://github.com/SebaBoler/vanguard/issues/503)) ([3fa1748](https://github.com/SebaBoler/vanguard/commit/3fa1748508aee33d350169b9eb690d8db6c9ab61)), closes [#496](https://github.com/SebaBoler/vanguard/issues/496) [#491](https://github.com/SebaBoler/vanguard/issues/491)
* **inspector:** one address for a CI run's records on both backends ([#516](https://github.com/SebaBoler/vanguard/issues/516)) ([626b278](https://github.com/SebaBoler/vanguard/commit/626b278942ddb8c5cd5b3f5363c620d627d2b35c)), closes [#499](https://github.com/SebaBoler/vanguard/issues/499)
* **skills:** inject skills into the spec, revise and review runs ([#517](https://github.com/SebaBoler/vanguard/issues/517)) ([74055e0](https://github.com/SebaBoler/vanguard/commit/74055e00138f7b5ef34cbc4dd2b1dfb12cefdcd1))
* **skills:** merge the repo's .github/vanguard-skills into every run ([#515](https://github.com/SebaBoler/vanguard/issues/515)) ([6fbbc39](https://github.com/SebaBoler/vanguard/commit/6fbbc39364758a21fd76bafc997e8f4b8bccafef))


### Bug Fixes

* **desktop:** run-record types from src/wire.ts, diffOmitted and visualProof in the UI, RemoteRun.cached on the hub ([#505](https://github.com/SebaBoler/vanguard/issues/505)) ([a4919a5](https://github.com/SebaBoler/vanguard/commit/a4919a5c29813105a6ec547dd128908e5c5a6629)), closes [#492](https://github.com/SebaBoler/vanguard/issues/492)
* **hub:** api_create_task runs validateCreateTask; one core-method table behind both dispatchers ([#508](https://github.com/SebaBoler/vanguard/issues/508)) ([d59785e](https://github.com/SebaBoler/vanguard/commit/d59785e7180f7bb12927c7dadb0d2331fe04fd31)), closes [#500](https://github.com/SebaBoler/vanguard/issues/500) [#493](https://github.com/SebaBoler/vanguard/issues/493)
* **hub:** same-origin check compares host, not scheme ([#506](https://github.com/SebaBoler/vanguard/issues/506)) ([1ef03d4](https://github.com/SebaBoler/vanguard/commit/1ef03d43129f0a6a94e7669bfa4edc75bd44e579)), closes [#490](https://github.com/SebaBoler/vanguard/issues/490)

### Code Refactoring

* **core:** one run-record store (`src/core/run-store.ts`, `beginRun()` returns a `RunWriter` that owns the run timestamp); `persistStageOutcomes`/`persistRunRecord` stay exported one release as deprecated wrappers (SebaBoler/vanguard[#497](https://github.com/SebaBoler/vanguard/issues/497)) ([#510](https://github.com/SebaBoler/vanguard/issues/510)) ([119fd6e](https://github.com/SebaBoler/vanguard/commit/119fd6e207a386406b4e0fd8c3cab1270cf571f6))

## [1.7.0](https://github.com/SebaBoler/vanguard/compare/v1.6.0...v1.7.0) (2026-10-17)


### Features

* test(hub): browse/rpc tests compare un-realpathed tmp paths and fail on macOS (SebaBoler/vanguard[#477](https://github.com/SebaBoler/vanguard/issues/477)) ([#486](https://github.com/SebaBoler/vanguard/issues/486)) ([4b8aafb](https://github.com/SebaBoler/vanguard/commit/4b8aafb83328f7be1bb70986c30c3534373d93b6))


### Bug Fixes

* **hub:** RPC result envelope + Remote fetch wiring (browser smoke) ([#484](https://github.com/SebaBoler/vanguard/issues/484)) ([c6e9f24](https://github.com/SebaBoler/vanguard/commit/c6e9f2407815c5d8de2c07cebbfae7a4ba1d9789))
* **hub:** run detail shows proof-of-work again: proof.json shares the run timestamp and the reader falls back to the closest earlier proof (SebaBoler/vanguard[#487](https://github.com/SebaBoler/vanguard/issues/487)) ([#488](https://github.com/SebaBoler/vanguard/issues/488)) ([b42d646](https://github.com/SebaBoler/vanguard/commit/b42d6464d472d190efd50c4fed1c0f02fc9d3ee1))
* **hub:** serve the Tauri app icon as the web UI favicon ([#489](https://github.com/SebaBoler/vanguard/issues/489)) ([c02c443](https://github.com/SebaBoler/vanguard/commit/c02c443a626f038731abb48715a85b62b6fd3399))

## [1.6.0](https://github.com/SebaBoler/vanguard/compare/v1.5.0...v1.6.0) (2026-10-17)


### Features

* **ci:** opt-in upload of .vanguard/runs as a workflow artifact ([#481](https://github.com/SebaBoler/vanguard/issues/481)) ([3e9439d](https://github.com/SebaBoler/vanguard/commit/3e9439d8180ea19e6037a59a1d44c28364031cfb))

## [1.5.0](https://github.com/SebaBoler/vanguard/compare/v1.4.2...v1.5.0) (2026-10-17)


### Features

* **hub:** Vanguard Hub slice 1 — `vanguard hub` serves the Inspector screens in a browser over HTTP + SSE against a real `.vanguard/` directory, with a Docker image for self-hosting ([#472](https://github.com/SebaBoler/vanguard/issues/472)): hub modules ([#473](https://github.com/SebaBoler/vanguard/pull/473)) ([35c14b6](https://github.com/SebaBoler/vanguard/commit/35c14b6)), server entrypoint and CLI ([#479](https://github.com/SebaBoler/vanguard/pull/479)) ([0cba718](https://github.com/SebaBoler/vanguard/commit/0cba718)), browser transport and hub-mode UI in `apps/desktop` ([#480](https://github.com/SebaBoler/vanguard/pull/480)) ([fdc2df9](https://github.com/SebaBoler/vanguard/commit/fdc2df9))
* **ci:** write run summary to GITHUB_STEP_SUMMARY ([#469](https://github.com/SebaBoler/vanguard/issues/469)) ([ab83663](https://github.com/SebaBoler/vanguard/commit/ab836633ecb9622ff9edc74b8b2ff0adfed7fdd5))
* **desktop:** pull CI run records into the Inspector ([#470](https://github.com/SebaBoler/vanguard/issues/470)) ([0206248](https://github.com/SebaBoler/vanguard/commit/0206248890f3c5e20c094f6735f6f3be5ed1ecce))
* **metrics:** opt-in OTLP trace export for Langfuse ([#471](https://github.com/SebaBoler/vanguard/issues/471)) ([4e3bd43](https://github.com/SebaBoler/vanguard/commit/4e3bd434a02e4c37cfef206c0becd5f2c9035c3c))


### Bug Fixes

* **run-record:** redact transcripts, drop diff and bundle for secret-blocked runs ([#478](https://github.com/SebaBoler/vanguard/issues/478)) ([cdf79e0](https://github.com/SebaBoler/vanguard/commit/cdf79e0a4f289413d04af2242d7d1c4373f49186))

## [1.4.2](https://github.com/SebaBoler/vanguard/compare/v1.4.1...v1.4.2) (2026-10-15)


### Bug Fixes

* **deps:** clear every open dependabot alert ([#467](https://github.com/SebaBoler/vanguard/issues/467)) ([28442f2](https://github.com/SebaBoler/vanguard/commit/28442f224a796127ed1a885399572143728e525b))

## [1.4.1](https://github.com/SebaBoler/vanguard/compare/v1.4.0...v1.4.1) (2026-10-14)


### Bug Fixes

* **verify:** detect check-types as the typecheck step ([#465](https://github.com/SebaBoler/vanguard/issues/465)) ([2656072](https://github.com/SebaBoler/vanguard/commit/265607230105536a46a73605d181637bb5442c0c))

## [1.4.0](https://github.com/SebaBoler/vanguard/compare/v1.3.0...v1.4.0) (2026-10-13)


### Bug Fixes

* **cli:** watch and doctor reject --fork and --spec-file instead of ignoring them; one parseRunOptions for run and watch ([#459](https://github.com/SebaBoler/vanguard/issues/459)) ([80b3589](https://github.com/SebaBoler/vanguard/commit/80b35893fdf7486911a86ad135dd4788663979ca))
* **watch:** hold a secret-blocked run for a human instead of reverting the claim ([#460](https://github.com/SebaBoler/vanguard/issues/460)) ([2aa7a35](https://github.com/SebaBoler/vanguard/commit/2aa7a35589b84d6eca07c954369c844ee129df94))

## [1.3.0](https://github.com/SebaBoler/vanguard/compare/v1.2.0...v1.3.0) (2026-10-09)


### Features

* --fallback-provider — the implementer retries on another provider when its own fails ([#453](https://github.com/SebaBoler/vanguard/issues/453)) ([474974a](https://github.com/SebaBoler/vanguard/commit/474974a4ba9c091c5a4ad97d2e4f73b251cf64a7))
* Flow editor: project switch discards unsaved flow edits without a confirm (SebaBoler/vanguard[#339](https://github.com/SebaBoler/vanguard/issues/339)) ([#435](https://github.com/SebaBoler/vanguard/issues/435)) ([009c860](https://github.com/SebaBoler/vanguard/commit/009c860610c0fc9d91fc4a88813c7c37189df10a))


### Bug Fixes

* **codex:** pass the prompt on stdin, not argv ([#454](https://github.com/SebaBoler/vanguard/issues/454)) ([9c88b41](https://github.com/SebaBoler/vanguard/commit/9c88b413c1c9974e3cc2cf68f4598d83651fc28c))
* retry the base fetch when a concurrent fetch holds the ref lock ([#434](https://github.com/SebaBoler/vanguard/issues/434)) ([#438](https://github.com/SebaBoler/vanguard/issues/438)) ([026d2ff](https://github.com/SebaBoler/vanguard/commit/026d2ffdee957d047386a10edaf981252a87c6e9))
* **review:** omit generated files from the review diff ([#455](https://github.com/SebaBoler/vanguard/issues/455)) ([f98f1b1](https://github.com/SebaBoler/vanguard/commit/f98f1b123429b3b73faa58a6294b1555619ae2fc))
* **security:** revise-pr scans the revision diff for secrets before commit and push ([#440](https://github.com/SebaBoler/vanguard/issues/440)) ([9d64f06](https://github.com/SebaBoler/vanguard/commit/9d64f069c183f7efa7f9022a0caa7bbe2c66441e))

## [1.2.0](https://github.com/SebaBoler/vanguard/compare/v1.1.1...v1.2.0) (2026-10-08)


### Features

* deps: migrate to execa 10 (SebaBoler/vanguard[#397](https://github.com/SebaBoler/vanguard/issues/397)) ([#432](https://github.com/SebaBoler/vanguard/issues/432)) ([3eb4fa9](https://github.com/SebaBoler/vanguard/commit/3eb4fa9b8fadcffc3856c99b413761abc1db498d))


### Bug Fixes

* cut the task worktree from origin/&lt;base&gt; when it is ahead of the local base ([#429](https://github.com/SebaBoler/vanguard/issues/429)) ([#431](https://github.com/SebaBoler/vanguard/issues/431)) ([50cf147](https://github.com/SebaBoler/vanguard/commit/50cf147736e394a687f40b77262ff53815e5fe02))

## [1.1.1](https://github.com/SebaBoler/vanguard/compare/v1.1.0...v1.1.1) (2026-10-08)


### Bug Fixes

* rebase the task branch onto the remote base before publishing ([#423](https://github.com/SebaBoler/vanguard/issues/423)) ([#426](https://github.com/SebaBoler/vanguard/issues/426)) ([16d70d1](https://github.com/SebaBoler/vanguard/commit/16d70d1918e8a46bf2e9003a16673208c1823217))

## [1.1.0](https://github.com/SebaBoler/vanguard/compare/v1.0.0...v1.1.0) (2026-10-08)


### Features

* --escalate-model — resume the 2nd+ gate repair on a stronger model ([#407](https://github.com/SebaBoler/vanguard/issues/407)) ([5f4dcd9](https://github.com/SebaBoler/vanguard/commit/5f4dcd93faa51c35b2698ed1895b87aa4f9580ff))
* current-generation models — 5.5/Fable 5.1 prices, aliases repointed, alias resolution not a swap ([#417](https://github.com/SebaBoler/vanguard/issues/417)) ([8c37e59](https://github.com/SebaBoler/vanguard/commit/8c37e5952592fc890240a256cd0c7393a51a6a9a))
* decision model as fork scorer and eval judge ([#413](https://github.com/SebaBoler/vanguard/issues/413)) ([f12f011](https://github.com/SebaBoler/vanguard/commit/f12f0117ee2fb3d7bda85adc832bb1200d962409))
* **desktop:** collapsible icon sidebar + shell alignment + single @/ui seam ([#312](https://github.com/SebaBoler/vanguard/issues/312)) ([4cb02fa](https://github.com/SebaBoler/vanguard/commit/4cb02fa4ff4d8c975d233ccd2400a34de2914500))
* **desktop:** Kanban board glow-up + project-color hover + rail collapse fix ([#315](https://github.com/SebaBoler/vanguard/issues/315)) ([7591793](https://github.com/SebaBoler/vanguard/commit/75917934348810229f3346c7f314eb08b17d9177))
* **desktop:** live cost/budget strip on the run viewer ([#317](https://github.com/SebaBoler/vanguard/issues/317)) ([b9bc59e](https://github.com/SebaBoler/vanguard/commit/b9bc59ebccd73c56effa57c7193baf3f613d8dba))
* **desktop:** show in-flight runs as rows in the Runs table, not a card ([#320](https://github.com/SebaBoler/vanguard/issues/320)) ([5ec052a](https://github.com/SebaBoler/vanguard/commit/5ec052a4302a5ad8e9e164f0ffb57ca2f9a1c250))
* Editor chrome: indent guides, bracket matching, status bar (Editor UX 2/7) (SebaBoler/vanguard[#357](https://github.com/SebaBoler/vanguard/issues/357)) ([#365](https://github.com/SebaBoler/vanguard/issues/365)) ([1c04130](https://github.com/SebaBoler/vanguard/commit/1c04130fab0e4ead3cd9b0669a70d6f6ab9873ea))
* Editor interaction: multi-cursor and VSCode keybindings (Editor UX 3/7) (SebaBoler/vanguard[#358](https://github.com/SebaBoler/vanguard/issues/358)) ([#367](https://github.com/SebaBoler/vanguard/issues/367)) ([619ea42](https://github.com/SebaBoler/vanguard/commit/619ea42863b00b2f7eebed7d7a3f3bdcccb7efc3))
* Editor UX upgrade (SebaBoler/vanguard[#352](https://github.com/SebaBoler/vanguard/issues/352)) ([#363](https://github.com/SebaBoler/vanguard/issues/363)) ([0dd0c8c](https://github.com/SebaBoler/vanguard/commit/0dd0c8cc139d6cc69b13b6b1c6657bf0325a6d4d))
* Linear tasks open GitLab MRs; review-mr skips reviewed heads ([#398](https://github.com/SebaBoler/vanguard/issues/398)) ([8cd4eea](https://github.com/SebaBoler/vanguard/commit/8cd4eea99404a1e2a7d98705e7dc971433b4e441))
* log-only difficulty probe via a decision model (Clef / System One API) ([#410](https://github.com/SebaBoler/vanguard/issues/410)) ([d95a353](https://github.com/SebaBoler/vanguard/commit/d95a35352a4be9f41c8a4799fde757f5e789e567))
* **review:** let review-mr and review-pr take --max-turns ([#402](https://github.com/SebaBoler/vanguard/issues/402)) ([39e503c](https://github.com/SebaBoler/vanguard/commit/39e503cbf0a1d66b89e4bbe186fbba7a28266386))
* **s10:** task drafts — the Docs page dies, authoring becomes task-first ([#349](https://github.com/SebaBoler/vanguard/issues/349)) ([f682b78](https://github.com/SebaBoler/vanguard/commit/f682b7828f1aa50dbf3bab08fef7745be230b5fd))
* **s4.3:** create a task from a doc — the app's first irreversible write ([#335](https://github.com/SebaBoler/vanguard/issues/335)) ([9c8050a](https://github.com/SebaBoler/vanguard/commit/9c8050a7d54c8ca16a214cf953d781b19f0ad945))
* **s5.1:** flows go live — .vanguard/flows/*.hcl discoverable, runnable, writable ([#336](https://github.com/SebaBoler/vanguard/issues/336)) ([d4272a2](https://github.com/SebaBoler/vanguard/commit/d4272a23b3bc3f7a79453aa95ccab84696970ef9))
* **s5.2:** visual flow editor — Workflow screen reads and writes real flow HCL ([#338](https://github.com/SebaBoler/vanguard/issues/338)) ([6ab753e](https://github.com/SebaBoler/vanguard/commit/6ab753e3686b641aa8b8f76d8fe82c00cb639b92))
* **s6.1:** custom providers go live — repo-configured Anthropic-compatible endpoints ([#340](https://github.com/SebaBoler/vanguard/issues/340)) ([89320fe](https://github.com/SebaBoler/vanguard/commit/89320fe0821a45852d840c39dc32935def39eaed))
* **s6.2:** custom providers in the app — NewRunForm merge, Settings editor, config data-safety ([#341](https://github.com/SebaBoler/vanguard/issues/341)) ([b93b195](https://github.com/SebaBoler/vanguard/commit/b93b19513272611ed973efb048ba43db87f5eb8f))
* **s7:** shared-types seam — one generated wire contract, mirror class deleted ([#342](https://github.com/SebaBoler/vanguard/issues/342)) ([828fe3c](https://github.com/SebaBoler/vanguard/commit/828fe3c168c5a41ab3d199c91d141e9d6503f374))
* **s8.1:** hygiene bundle — double-scroll, drag cancel, input feedback, strip bleed, nav guard ([#339](https://github.com/SebaBoler/vanguard/issues/339)) ([#343](https://github.com/SebaBoler/vanguard/issues/343)) ([62c4fbe](https://github.com/SebaBoler/vanguard/commit/62c4fbe2e1f941769821b3e732800892094e7f62))
* **s8.2:** in-app flow rename + delete (additive deleteFlow method) ([#345](https://github.com/SebaBoler/vanguard/issues/345)) ([fac70ff](https://github.com/SebaBoler/vanguard/commit/fac70ff001b3228f6df885ec9e6febcba0a39067))
* **s9.1:** board read path in core — listTasks/fetchSpec sidecar methods ([#346](https://github.com/SebaBoler/vanguard/issues/346)) ([45ea16a](https://github.com/SebaBoler/vanguard/commit/45ea16a1f631ab2c9969ecb19e13aad0c49b25fe))
* **s9.2:** the Rust board dies — one brain ([#348](https://github.com/SebaBoler/vanguard/issues/348)) ([5ca0227](https://github.com/SebaBoler/vanguard/commit/5ca02278a459ceb56ff919d945ca386f9948e670))
* **sidecar:** give short calls their own pipe; keep cancel pointed at the run child ([#334](https://github.com/SebaBoler/vanguard/issues/334)) ([69162fb](https://github.com/SebaBoler/vanguard/commit/69162fbfeaf095dbc7084230e5b408f0b18da293))
* **spec:** --base flag + auto-fetch origin baseline for the spec pass ([#311](https://github.com/SebaBoler/vanguard/issues/311)) ([5936a56](https://github.com/SebaBoler/vanguard/commit/5936a56f58f1f374c9438ba2a51bb92c361f8828))
* **task-page:** full-page editor with a tabbed chat drawer ([#350](https://github.com/SebaBoler/vanguard/issues/350)) ([24d0122](https://github.com/SebaBoler/vanguard/commit/24d012263c577e28453bdad99890c5b04884a8b9))
* vanguard metrics push + stats --branch — durable run metrics on an orphan branch ([#419](https://github.com/SebaBoler/vanguard/issues/419)) ([e8c76ef](https://github.com/SebaBoler/vanguard/commit/e8c76efe7c742a79638b7a8af592361db37b4b9a))
* vanguard:model=&lt;m&gt; issue label pins the implementer model per task ([#409](https://github.com/SebaBoler/vanguard/issues/409)) ([16f7481](https://github.com/SebaBoler/vanguard/commit/16f7481ef5d35895addb98a55c07dd2554589d21))
* **watch:** add --spec-only to run the loop-v1 spec pass alone ([#400](https://github.com/SebaBoler/vanguard/issues/400)) ([0155ebc](https://github.com/SebaBoler/vanguard/commit/0155ebc14a76c124d52042d80e6e3c3cd9003eae))


### Bug Fixes

* codex/cursor-only review needs no Anthropic credential; log why a watched item failed ([#422](https://github.com/SebaBoler/vanguard/issues/422)) ([abe3256](https://github.com/SebaBoler/vanguard/commit/abe3256e46512ccadf8061d45ae1b92031cf48d9))
* **desktop:** default runs to claude, drop dead zai/--llm-proxy hardcode ([#321](https://github.com/SebaBoler/vanguard/issues/321)) ([57d0669](https://github.com/SebaBoler/vanguard/commit/57d06694a7ecc7bc76f5c415c31bf9cd6220339e))
* **desktop:** Fleet watch-loop toggle falsely reads 'stopped' after navigating away (SebaBoler/vanguard[#318](https://github.com/SebaBoler/vanguard/issues/318)) ([#319](https://github.com/SebaBoler/vanguard/issues/319)) ([4d14e2b](https://github.com/SebaBoler/vanguard/commit/4d14e2bc9804547853b06a58e0f7a76fe576c731))
* **dogfood:** proxy EPIPE crash-loop killed run [#352](https://github.com/SebaBoler/vanguard/issues/352) again; live-run strip trapped the Runs page ([#354](https://github.com/SebaBoler/vanguard/issues/354)) ([e016ec0](https://github.com/SebaBoler/vanguard/commit/e016ec07b26bf6aa53d7489f6c9dd35ad8d98a38))
* fail fast when every assistant turn is a synthetic API error ([#392](https://github.com/SebaBoler/vanguard/issues/392)) ([eed565a](https://github.com/SebaBoler/vanguard/commit/eed565a82a478068a490933f21b837c3857a6b4b))
* follow-ups from the last [#398](https://github.com/SebaBoler/vanguard/issues/398) review ([#399](https://github.com/SebaBoler/vanguard/issues/399)) ([2315cfa](https://github.com/SebaBoler/vanguard/commit/2315cfa4b8879b9d6dea41e6784e449c602bee7d))
* gate runs on the pinned sandbox claude CLI, add doctor --fix ([#393](https://github.com/SebaBoler/vanguard/issues/393)) ([70729db](https://github.com/SebaBoler/vanguard/commit/70729db40875d1bcc21c2e5bdc61b858147c6cb1))
* keep truncations visible after repair, annotate gateway swaps in stats, map Claude aliases on openrouter ([#406](https://github.com/SebaBoler/vanguard/issues/406)) ([6d37155](https://github.com/SebaBoler/vanguard/commit/6d37155ac7b1aef9eace5279efa4829b45db3bcc))
* **linear:** list over GraphQL — `vanguard watch --linear` was broken on every poll ([#333](https://github.com/SebaBoler/vanguard/issues/333)) ([4203660](https://github.com/SebaBoler/vanguard/commit/4203660d382f60a15c44624ab225dd705db50544))
* log a self-contradicting review verdict (clean verdict, high finding) ([#412](https://github.com/SebaBoler/vanguard/issues/412)) ([48a485c](https://github.com/SebaBoler/vanguard/commit/48a485c0b44d593fa7a9c4ff6b8627ed8e71c337))
* loop-v1 spec pass researches against --base ([#401](https://github.com/SebaBoler/vanguard/issues/401)) ([e50d60b](https://github.com/SebaBoler/vanguard/commit/e50d60b237d37902a457b2704979fac3b33a862e))
* **pipeline:** an incomplete implementer fails the quality gate — no more residue PRs ([#356](https://github.com/SebaBoler/vanguard/issues/356)) ([d83c3d7](https://github.com/SebaBoler/vanguard/commit/d83c3d7a80b52aea3623e97d0c91f4805a0930aa))
* **pr-review:** failed reviews retry instead of posing as success; pin event PR past stale label scan ([#344](https://github.com/SebaBoler/vanguard/issues/344)) ([727a00a](https://github.com/SebaBoler/vanguard/commit/727a00a074f2dd660c344a1c9ce8a78d71b86b9a))
* review verdict first — accept a stated verdict without the completion signal, stop calling small diffs too large ([#411](https://github.com/SebaBoler/vanguard/issues/411)) ([a23f663](https://github.com/SebaBoler/vanguard/commit/a23f66345479e377c4d371496579616892d6af1a))
* route repair loops on the implementer model, keep all-attempt cost, stats by model ([#404](https://github.com/SebaBoler/vanguard/issues/404)) ([45975c1](https://github.com/SebaBoler/vanguard/commit/45975c11bf167d5ead1c779581f76367fe5b66cf))
* **sandbox:** coerce undefined execa streams in ExecResult ([#382](https://github.com/SebaBoler/vanguard/issues/382)) ([194bb6f](https://github.com/SebaBoler/vanguard/commit/194bb6fb808404a48e9da4259a1f1a41276547ca))
* **sandbox:** supervise the egress proxy — proxy death bricked run [#352](https://github.com/SebaBoler/vanguard/issues/352) ([#353](https://github.com/SebaBoler/vanguard/issues/353)) ([6ba7c86](https://github.com/SebaBoler/vanguard/commit/6ba7c860e7c4a83746a4709041d71de4e089d797))
* **spec:** resume incomplete tech-spec, keep text on empty result ([#380](https://github.com/SebaBoler/vanguard/issues/380)) ([39bd9d5](https://github.com/SebaBoler/vanguard/commit/39bd9d517eb06b8b743a638b30428dfdcd2982f6))
* **spec:** tech-spec turn cap 15→30, wire --max-turns, planner 10→15 ([#347](https://github.com/SebaBoler/vanguard/issues/347)) ([a61940d](https://github.com/SebaBoler/vanguard/commit/a61940d3426e106b745dc1a77c95f999459e2d21))
* **task-page:** dogfood r3 — unbreak doc chat, split conversation/doc naming into InlineEdits ([#351](https://github.com/SebaBoler/vanguard/issues/351)) ([e68db34](https://github.com/SebaBoler/vanguard/commit/e68db34f83aa0056150479aa1ab8d06c021612a2))
* **watch:** carry the stack into failure comments ([#381](https://github.com/SebaBoler/vanguard/issues/381)) ([5ea9006](https://github.com/SebaBoler/vanguard/commit/5ea900634a756e0f353106b0456217d22d853851))
