# Hosting a public arena

> Status: the `Dockerfile` and `fly.toml` in this repo were written without Docker or `flyctl` available, so **they have not been built or run yet**. Do the local smoke test in section 3 before trusting them, and treat the first deploy as the verification.

## 1. What you are deploying

One container, one persistent volume, exactly one instance.

The file store, the live-game registry and the tournament runner all live inside one Node process. That is why serverless hosts (Vercel functions and the like) are not supported for live mode or tournaments, and why you must never run two instances against the same volume: the store's write lock is in-process.

## 2. Before you start

- Fly.io is a paid host and needs a billing account. Nothing in this repo creates an account or deploys for you.
- Set a hard spend limit on every provider API key you give the arena. The guard below is the first line of defence; the provider's spend limit is the last.

## 3. Local smoke test (needs Docker)

```bash
docker build -t among-llms .
docker run --rm -p 3000:3000 -v among-llms-data:/data -e ARENA_ADMIN_TOKEN=<32+ random chars> among-llms
curl http://localhost:3000/api/health
```

The health call should return `{"ok":true,"persistent":true,"mode":"bots","adminConfigured":true,...}` with an empty `warnings` list.

Manual checks to run against the container (none of these are automated):

1. `curl -N http://localhost:3000/api/games/doesnotexist/stream` prints one `event: end` frame with `{"reason":"not_found"}` and then exits.
2. Start a live bot game in the browser: events arrive one by one, not in a single burst at the end (SSE is not being buffered).
3. Restart the container during a real-model live game: the viewer shows "Match interrupted".
4. Restart the container during a tournament: the tournament page shows the interrupted badge.

## 4. Fly.io procedure

1. Install `flyctl`, then `fly auth login`.
2. Edit `app` and `primary_region` in `fly.toml`.
3. `fly launch --no-deploy --copy-config`
4. `fly volumes create arena_data --size 1 --region <region>`
5. Generate a token:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   (This works in PowerShell, cmd and Git Bash; `openssl` is not on PATH in PowerShell.) Then `fly secrets set ARENA_ADMIN_TOKEN=<that value>` and save the token in a password manager. Optionally also set `OPENAI_API_KEY`, `OPENAI_MODELS`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODELS`.
6. `fly deploy --ha=false`
7. `fly scale count 1`. Never run more than one machine.
8. Verify health: `curl https://<app>.fly.dev/api/health` returns `ok: true`, `persistent: true`, `mode: "bots"`, `adminConfigured: true` and an empty `warnings` list.
9. Verify the guard:
   - `POST /api/games/live` with body `{"seatModels":["<a real model id>"]}` returns 401 without the header and 202 with `Authorization: Bearer <token>`.
   - A bot game returns 202 without a token.
   - The seventh bot start inside a minute returns 429.
10. Open the site, paste the token into "Admin token", and seat a real model.

`NEXT_PUBLIC_GITHUB_URL` is inlined at build time. To change the header link, pass it as a build arg: `fly deploy --ha=false --build-arg NEXT_PUBLIC_GITHUB_URL=https://…` (or `docker build --build-arg …`).

## 5. Environment reference

All optional. With none set the app behaves exactly like a local install.

| Var | Meaning | Unset |
|---|---|---|
| `ARENA_DATA_DIR` | Store directory. Strict: an unwritable dir is an error and `/api/health` returns 503. Also marks the process as hosted, which enables the boot-time tournament reconcile. | `./data`, then a temp-dir fallback |
| `ARENA_ADMIN_TOKEN` | Operator secret, at least 16 characters, sent as `Authorization: Bearer <token>`. A shorter value disables admin and adds a health warning. | no admin exists |
| `ARENA_PUBLIC_MODE` | What visitors may start: `open` (anything), `bots` (bot-only games, including playing a seat yourself against bots; no real models, no tournaments), `off` (nothing). An unrecognised value is treated as `bots` with a warning. | `bots` if `ARENA_ADMIN_TOKEN` is non-empty, else `open` |
| `ARENA_RATE_LIMIT` | Starts per minute per client, across every start route (run, watch live, play a seat, tournament). Visitors only. | off |
| `ARENA_DAILY_GAMES` | Visitor starts admitted per 24 h, all clients combined. A game costs 1 and a tournament costs 1. | off |
| `ARENA_MAX_GAMES` | Standalone games running at once: live games, human-seat games and blocking runs in flight. Applies to everyone. Tournament games are not counted. | off |
| `ARENA_MAX_TOURNAMENTS` | Tournaments running at once. Applies to everyone. | off |
| `ARENA_IP_HEADER` | Request header that carries the client IP (`fly-client-ip` on Fly). If it contains commas, the last entry is used. | all visitors share one rate-limit bucket |
| `NEXT_OUTPUT` | `standalone` at build time. Set by the Dockerfile only. | normal build |

Numeric variables: a positive integer enables the limit, empty means off, anything else means off and adds a warning to `/api/health`.

The image sets `ARENA_DATA_DIR=/data` and `ARENA_PUBLIC_MODE=bots`. If you forget the token, real models and tournaments are denied to everyone rather than opened to everyone.

How the limits treat a human seat ("play a seat yourself"):

- Starting one is a game start like any other: it obeys the public mode, needs the admin token if any bot seat is a real model, and counts toward the rate limit, the daily budget and `ARENA_MAX_GAMES`. There is also a fixed cap of 3 human games at a time.
- Answers from a seated player are only flood-limited (20 actions per allowed start, per minute, per client), and only when `ARENA_RATE_LIMIT` is set. Mode, budget and caps do not apply to them, so a player who was admitted can always finish.
- The admin token never replaces the seat cookie and never reveals a running human game: its spectator stream stays sealed for everyone until the game ends.

## 6. Warning: open mode and provider keys

Provider keys together with `ARENA_PUBLIC_MODE=open` let anyone spend them. `/api/health` warns about exactly this combination.

Also in `open` mode: tournament games are run by the tournament runner directly, up to 8 at once, so `ARENA_MAX_GAMES` does not bound them, and `ARENA_DAILY_GAMES` counts a whole tournament as 1 although it can write dozens of transcripts. There the bounds on tournament load are `ARENA_MAX_TOURNAMENTS`, `ARENA_RATE_LIMIT`, the one-per-tournament budget charge and the built-in clamps on tournament size. In `bots` and `off` mode only the admin can start tournaments, so this does not apply.

## 7. Operations

- **Redeploys.** A redeploy ends running live games (viewers see "Match interrupted"; a player in a human-seat game loses that game) and marks running tournaments as interrupted. Finished games, the leaderboard and finished tournaments are intact. Do not deploy during a tournament you care about.
- **Real-model games must be started with "Watch live".** The blocking "Run a match" request sends nothing until the game ends, and Fly's proxy cuts an idle response at about 60 s; the game still finishes and is rated, but the browser shows a network error. The form disables that button for real models on a hosted arena.
- **Backup**, in two steps so no binary data passes through a shell redirect (PowerShell's `>` corrupts it): `fly ssh console -C "tar czf /tmp/backup.tgz /data"`, then `fly ssh sftp get /tmp/backup.tgz`. Also `fly volumes snapshots list`.
- **Rotate the token** with `fly secrets set ARENA_ADMIN_TOKEN=…`.
- **Disk.** Transcripts are never deleted. Watch volume usage, and lower `ARENA_DAILY_GAMES` or extend the volume as needed. `ARENA_DAILY_GAMES=2000` with a 1 GB volume is a starting value, not a measured one.
- **Root.** The container runs as root because a Fly volume mounts root-owned.
- **Ollama** is not reachable from Fly unless you host it yourself.
- **Rate-limit state is in memory.** A restart resets the per-client windows and the daily budget.

## 8. Other hosts (Railway, Render, a VPS)

Use the same image. Mount a volume at `/data`, set `ARENA_IP_HEADER` to that proxy's client-IP header, and run exactly one instance. Only name a header your proxy sets itself and overwrites; a header the client controls makes the per-client limit spoofable (the daily budget and the caps still hold).

## 9. Troubleshooting

- **Health returns 503.** The volume is not mounted or not writable.
- **Everyone is rate-limited together.** `ARENA_IP_HEADER` is unset or names the wrong header.
- **`Cannot find module …linux-x64-gnu` during the image build.** Regenerate `package-lock.json` with `npm install` on any machine and rebuild.
- **Container exits with `Cannot find module '../../lib/metadata/metadata-constants'`.** Someone added `outputFileTracingExcludes` with a `data/**` pattern to `next.config.mjs`. Next matches those globs as substrings, so it also strips `next/dist/lib/metadata` from the standalone output. Remove the key; `.dockerignore` already keeps `data/` out of the image.
- **A viewer sits on "Connecting" forever.** The proxy is buffering the event stream; check that responses with `content-type: text/event-stream` are passed through unbuffered.
