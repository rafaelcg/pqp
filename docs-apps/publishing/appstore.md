# The appstore (planned)

::: warning Not built
Everything on this page is **planned or undecided**. There is no appstore, no publisher account, no submission form and no listing page today. This page exists so you know what is coming, what the platform already leaves room for, and what is still open, without promising anything that is not true.
:::

## What the plan is

A place where people find apps for pqp, and where people who build them can put one in front of everybody, instead of every app being written by the pqp team and merged into the repository. The part you are reading, the SDK and its docs, is the builder side of it: the sooner there are apps worth listing, the sooner the listing is worth building.

## What the platform already leaves room for

These exist in the code and the data model today, so the appstore does not have to start from scratch:

- **Publishers.** An `app_publishers` table distinguishes first-party from third-party publishers and records an owning account, with a suspended flag. Today there is one row, `pqp`. The table's own comment says third-party rows "arrive only with the submission path".
- **Two sources of a version.** `app_versions.source` is `repo` (built from the repository and loaded from the catalog at boot, which is how every app arrives now) or `submission` (uploaded by a publisher, later).
- **A review record per version**, with a checklist, a reviewer and a note. See [Review and availability](/publishing/review).
- **Listing fields in the manifest.** `store.summary`, `store.screenshots` (up to six, hashed), `store.homepage` and `store.support` are accepted today and unused.
- **Availability by server.** The operator and each server owner decide where an app may run.
- **A manifest that must be open source.** Every app already declares a license and a source URL.
- **A deterministic, hashed bundle**, the same file for everybody, which is what makes a submission verifiable.

## What does not exist

- **A submission path.** Uploading a bundle, building it, and holding it for review. The `submission` source is a column and nothing writes it.
- **Publisher accounts and verification.** Who may publish under which name.
- **A public listing.** A page that shows apps, screenshots and what each asks for.
- **The package on npm.** `@pqp/app-sdk` is prepared but not published. See [the SDK page](/sdk/#everything-it-exports).
- **A way to build outside the repository.** The packager and the dev server work on `apps/*` inside a checkout today.

## Open decisions

None of these is settled, and this list is not a roadmap:

- How a third-party app is built and reviewed: from a repository the publisher links, or from an uploaded bundle.
- How long a review takes, and what a rejection looks like.
- Whether and how an app may charge people. Nothing in the platform supports payment today, and none is promised.
- Where the docs and the listing live, under which address.

If you are building an app and one of these matters to you, say so in an issue on the [repository](https://github.com/rafaelcg/pqp/issues). What people ask for decides the order.
