# pi-subagents browser compatibility

Pi Forge reads the installed `pi-subagents` native supervisor channel (0.37) directly. Open **Subagent fleet** to see supervisor requests alongside their parent session and run.

## Supervisor requests

The **Supervisor requests** frame is expanded on first view. Its accessible toggle keeps the browser's collapsed or expanded choice through fleet polling and page reloads. Individual request cards stay independently collapsible.

The outer frame and its cards use separate borders, headers, and backgrounds so their hierarchy is visible without relying on color alone. Each request shows its exact `parentSessionId`, `runId`, and `requestId`, plus the request text and structured interview context when present.

### Reply transport vs. decision

Reply transport and decision are intentionally separate:

- **Reply sent** means Forge wrote a reply to the native channel; it does not confirm agent consumption.
- **Answered — reply observed** means a reply file was observed, including a terminal-originated reply; it does not confirm agent consumption.
- **No decision recorded** is shown for every free-text reply and for terminal-originated replies.
- **Approved** and **Rejected** are only recorded by Forge's explicit **Approve** and **Reject** actions on `need_decision` requests.

Approve and Reject write a native reply with a matching Forge decision classification (`approved` or `rejected`). The native 0.37 reader still consumes the normal reply message. Forge never infers a decision from arbitrary reply text. When Forge controls a decision reply, its persisted classification survives reply reconciliation; a terminal-only reply remains `no-decision`.

Request history is stored newest-first in Forge data (up to 500 entries) and is recovered after a browser reload or server reconnect. When pi-subagents removes an answered request file, Forge correlates its matching reply file before preserving the answered history state. A request is expired only when its native `expiresAt` deadline has passed.

The legacy decline endpoint remains available for compatibility and is explicitly treated as a Reject decision. It sends `Rejected by supervisor.` unless a message is provided.

## API

All endpoints use the normal API authentication:

- `GET /api/v1/subagent-supervisor/requests`
- `POST /api/v1/subagent-supervisor/requests/:requestId/reply` with `{ "message": "..." }` records `no-decision`
- `POST /api/v1/subagent-supervisor/requests/:requestId/approve` with optional `{ "message": "..." }` records `approved`
- `POST /api/v1/subagent-supervisor/requests/:requestId/reject` with optional `{ "message": "..." }` records `rejected`
- `POST /api/v1/subagent-supervisor/requests/:requestId/decline` is a compatibility alias for Reject

Reply, approve, reject, and decline endpoints validate input, are rate limited with the prompt-control limit, and return a conflict if the request has expired or another client already replied. Approve and Reject are only valid for native `need_decision` requests.

## Unsupported native progress updates

`pi-subagents` 0.37 removes `progress_update` artifacts during its fast poll, before Forge can safely guarantee bounded persistent ingestion. Forge intentionally exposes only reply-bearing `need_decision` and `interview_request` requests; progress updates are unsupported in this browser compatibility view.

## Native protocol limitation

`pi-subagents` 0.37 defines only a reply file for supervisor requests. It has no native acknowledgement beyond the child consuming that reply. Forge therefore does not emulate a terminal pause or claim that a child processed a response.
