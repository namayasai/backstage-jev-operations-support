# Contributing

Use Node.js 22+, run `npm ci`, and verify changes with `npm run check`. Keep workflows narrow, return uncertainty explicitly, and test failure paths. Add synthetic test cases for changes to prompts or thresholds. Do not add credentials, private catalog data, production runbooks, or unredacted provider responses to issues or commits.

Run `npm run dev` for the fixture workbench. Live tests are optional and require your own TypeSafe API key. Discuss new workflow integrations in an issue before introducing additional external services or automatic mutations.
