# pi-subagents browser compatibility

Pi Forge reads the installed `pi-subagents` native supervisor channel (0.37) directly. Open **Subagent fleet** to see supervisor requests alongside their parent session and run.

## Supervisor requests

Each request shows its exact `parentSessionId`, `runId`, and `requestId`, plus the request text and structured interview context when present. Replying writes the native `subagent.supervisor.reply` file atomically, so a raced browser or terminal reply cannot overwrite the first reply.

A request can be **open**, **sending** (in the active browser), **answered**, **declined**, or **expired**. Request history is stored in Forge data and is recovered after a browser reload or server reconnect. A request is expired only when its native `expiresAt` deadline has passed.

Decline is confirmed before it sends the safe native reply `Declined by supervisor.`. It is displayed as declined in Forge, but is still a normal reply to the child.

## API

All endpoints use the normal API authentication:

- `GET /api/v1/subagent-supervisor/requests`
- `POST /api/v1/subagent-supervisor/requests/:requestId/reply` with `{ "message": "..." }`
- `POST /api/v1/subagent-supervisor/requests/:requestId/decline` with optional `{ "message": "..." }`

Reply and decline endpoints validate input, are rate limited with the prompt-control limit, and return a conflict if the request has expired or another client already replied.

## Native protocol limitation

`pi-subagents` 0.37 defines only a reply file for supervisor requests. It has no native cancellation message or acknowledgement beyond the child consuming that reply. Forge therefore does not emulate a terminal pause or claim that a child processed a response. Decline is represented as a final reply; an absent request file without a reply is not labelled cancelled because that state is not authoritatively knowable.
