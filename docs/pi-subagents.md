# pi-subagents browser compatibility

Pi Forge reads the installed `pi-subagents` native supervisor channel (0.37) directly. Open **Subagent fleet** to see supervisor requests alongside their parent session and run.

## Supervisor requests

Each request shows its exact `parentSessionId`, `runId`, and `requestId`, plus the request text and structured interview context when present. Replying uses a no-replace link for concurrent Forge browser submissions. pi-subagents 0.37 terminal replies use overwrite-capable rename, so Forge cannot guarantee a global browser/terminal first-writer result; an upstream no-clobber reply write is necessary for that guarantee.

A request can be **open**, **sending** (in the active browser), **answered**, **declined**, or **expired**. Request history is stored newest-first in Forge data (up to 500 entries) and is recovered after a browser reload or server reconnect. When pi-subagents removes an answered request file, Forge correlates its matching reply file before preserving the answered history state. A request is expired only when its native `expiresAt` deadline has passed.

Decline is confirmed before it sends the safe native reply `Declined by supervisor.`. It is displayed as declined in Forge, but is still a normal reply to the child.

## API

All endpoints use the normal API authentication:

- `GET /api/v1/subagent-supervisor/requests`
- `POST /api/v1/subagent-supervisor/requests/:requestId/reply` with `{ "message": "..." }`
- `POST /api/v1/subagent-supervisor/requests/:requestId/decline` with optional `{ "message": "..." }`

Reply and decline endpoints validate input, are rate limited with the prompt-control limit, and return a conflict if the request has expired or another client already replied.

## Unsupported native progress updates

`pi-subagents` 0.37 removes `progress_update` artifacts during its fast poll, before Forge can safely guarantee bounded persistent ingestion. Forge intentionally exposes only reply-bearing `need_decision` and `interview_request` requests; progress updates are unsupported in this browser compatibility view.

## Native protocol limitation

`pi-subagents` 0.37 defines only a reply file for supervisor requests. It has no native cancellation message or acknowledgement beyond the child consuming that reply. Forge therefore does not emulate a terminal pause or claim that a child processed a response. Decline is represented as a final reply; an absent request file without a reply is not labelled cancelled because that state is not authoritatively knowable.
