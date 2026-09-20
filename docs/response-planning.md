# Incident response suggestions

Available in version 0.4.0 and later. Keep all Jev Operations Support packages on the same version.

Jev classifies reported impact and an investigation area. An optional second LLM then reads the report and those Jev findings to propose hypotheses, verification steps and conditional response options. The UI keeps the two results separate. Suggestions never execute commands, change infrastructure, or establish a proven root cause.

## Where it runs

- **Triage** (`/jev-triage`): enter a human report, then run the check. Jev runs first; when configured, response planning follows automatically in the same request. A failed second stage still returns the Jev result. Editing while Live is enabled or leaving the page cancels superseded requests. This manual result is not stored.
- **Alerts** (`/jev-alerts`): a CloudWatch `ALARM` that receives a successful Jev assessment also receives response suggestions. The alert and Jev result are saved before waiting for the LLM. Generated suggestions, or a sanitized failure status, are added to the existing detail row. `OK` and `INSUFFICIENT_DATA` notifications do not generate response plans. The stored plan is visible when selecting the alert; a manual re-check produces an unsaved result with a fresh plan.
- **Pre-check** (`/jev-operations-support`): document, change, ownership, template and reference checks remain Jev-only. They do not send an extra request to this LLM.

## Configure one provider

The integration is off by default. Configure it server-side under the existing backend plugin. Its key is separate from the Jev key. Choose a model available to your account that supports the selected output format; there is deliberately no hard-coded model default.

```yaml
jevOperationsSupport:
  responsePlanning:
    enabled: true
    provider: openai
    model: ${INCIDENT_LLM_MODEL}
    apiKey: ${INCIDENT_LLM_API_KEY}
    timeoutMs: 30000
    maxOutputTokens: 4096
```

| Provider setting | Protocol | Configuration |
| --- | --- | --- |
| `openai` | Responses API at `https://api.openai.com/v1/responses` | Model supporting Structured Outputs; uses `store: false` |
| `anthropic` | Claude Messages at `https://api.anthropic.com/v1/messages` | Claude model supporting JSON outputs |
| `openai-compatible` | Chat Completions at `<baseUrl>/chat/completions` | Explicit `baseUrl` including `/v1`, a model and a key |

OpenAI's request uses `text.format` JSON Schema; Claude's uses `output_config.format`. Both are based on their official structured-output APIs. See [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [OpenAI response storage](https://developers.openai.com/api/docs/guides/migrate-to-responses), and [Claude Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

For another provider exposing an OpenAI-compatible endpoint:

```yaml
jevOperationsSupport:
  responsePlanning:
    enabled: true
    provider: openai-compatible
    baseUrl: https://llm.example.com/v1
    model: ${INCIDENT_LLM_MODEL}
    apiKey: ${INCIDENT_LLM_API_KEY}
    responseFormat: json_schema
```

A compatible API must support bearer authentication, Chat Completions, `max_tokens`, and the chosen response format. Set `responseFormat: json_object` if it supports JSON mode but not JSON Schema. Output is still validated against the same local schema. Non-compatible APIs require an adapter; this does not imply support for every vendor-specific API or authentication scheme. Only HTTPS is accepted except HTTP to localhost/loopback for local models; URLs cannot contain credentials, query strings or fragments. Redirects are refused.

Switch `provider`, `model` and the key in backend configuration to change LLM. There is no client-side key entry, arbitrary endpoint selection, provider fallback or model fan-out.

## What is sent and returned

The selected LLM receives the original incident text plus Jev's finding IDs, questions, values, statuses and confidence values. It does not receive API keys in the prompt, earlier LLM plans, unrelated catalog entries, PR contents, or documentation fetched behind the scenes. Native provider requests have no tools enabled. The report can itself contain sensitive operational information; the configured provider's data-handling policy applies. `store: false` is an OpenAI response-storage option, not a promise about all provider retention.

The validated response contains a summary, up to four hypotheses (with evidence and verification), six read-only checks, five possible actions (with preconditions, risks and recovery verification), and six missing-information items. Each text field is limited to 1200 characters. The UI renders plain text, not executable content. JSON conformity validates shape, not factual accuracy: operators still verify proposals against telemetry and their approved runbooks.

Only one attempt is made per assessment. The deadline is configurable from 1–60 seconds, the output-token budget from 256–8192, and response bodies are bounded to 128 KiB. Each planner instance admits two simultaneous generations and returns a busy state instead of building an unbounded queue. The existing per-user evaluation limit and AWS workload limit also apply. Native backend and AWS module planner instances have independent concurrency counters. Every repeated manual assessment or SNS redelivery can incur another provider call; there is no new job queue or cache.

Malformed, refused, incomplete, timed-out or failed responses never become a proposed plan. Provider error bodies are not returned or logged. The Jev result remains visible with a separate planning failure. AWS storage uses its existing detail table and retention period; there is no additional database.

With whole-installation `demoMode: true`, no live provider is called. Manual Triage can show a clearly marked fixed response-plan sample when `responsePlanning.enabled` is true. AWS automatic evaluation remains not-evaluated in demo mode, as before.
