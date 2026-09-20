# @namayasai/backstage-plugin-jev-operations-support

Part of [Jev Operations Support for Backstage](https://github.com/namayasai/backstage-jev-operations-support). See the repository [installation guide](https://github.com/namayasai/backstage-jev-operations-support/blob/main/docs/installation.md) for configuration and integration.

Besides the main `.`/`./alpha` exports (the Alerts/Pre-check page and entity tab), two more
subpaths put a workflow where it is chosen rather than on a separate page: `./search`
(`JevRerankedResults`, reranks a Backstage search result list — needs the optional peer
dependency `@backstage/plugin-search-react`) and `./scaffolder` (`JevTemplateAdvisor`, a
template-recommendation card with no Scaffolder package dependency). See the installation
guide's "Search and Scaffolder integrations" section.

**Disclosure:** with `JevRerankedResults` installed, choosing "Rank now" — or turning on Live,
which is off by default and opt-in per reader, remembered per browser — sends the query, and
the indexed title and an excerpt of the body text of the top results, to TypeSafe through your
Backstage backend. Search indexes commonly include content from private documentation. A host
can force this off for a given usage with `live={false}`, or leave it to each reader's own Live
switch; the `jev-operations-support.evaluate` permission and the backend's rate limit still apply.

Apache-2.0. Experimental v0.3.0.
