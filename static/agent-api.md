# Moja kawa: instructions for AI agents

Use this server-to-server API to manage the user's coffee recipe collection.
Base URL: `https://YOUR-COFFEE-DOMAIN/api/v1`.
OpenAPI: `https://YOUR-COFFEE-DOMAIN/api/openapi.json`.
Replace the hostname with the deployed app's hostname. Do not use localhost unless running locally.

## Authentication and setup

The owner sets `APP_API_TOKEN` in Coolify and redeploys. Generate a random secret:

```sh
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

It must be at least 32 characters. Supply it in every request:
`Authorization: Bearer YOUR_TOKEN`. Use HTTPS in production. Keep the token in your
agent's secret store, never a URL, frontend bundle, import file or Git commit.
It grants full read/write/delete access to this installation's shared collection.
It is independent of the PWA's login/password and cookie. A browser session does
not grant access to `/api/v1`. An unset token disables this API (503), even when
the PWA has no login. To revoke all agent access, replace or remove the token and
redeploy. There is one shared agent token, not individual agent accounts.
No CORS is enabled: call from your agent's backend, not a cross-origin webpage.

## Workflow

1. GET `/coffees` and find the correct existing coffee. Each coffee owns multiple
   independent recipes for different volumes and methods; do not create one
   coffee per volume. IDs come from the server; never invent or submit them.
2. To add a coffee, POST `/coffees` with its metadata only. The 201 response has
   `data.id`, `revision`, and a `Location` header. Then POST each recipe to
   `/coffees/{coffee_id}/recipes`.
3. To edit, GET the resource first and PATCH only intended fields. Keep the
   exact quoted `ETag` response header and send it as `If-Match` on your write.
   The revision covers the whole collection, not just one resource. Read again
   after any other write. Without If-Match, writes apply to the latest state.
4. On 412 another device or agent changed the collection. Refetch, compare and
   reapply the intended change. Do not blindly retry a stale destructive action.
5. A duplicate normalized coffee name or identical recipe on creation returns
   409 with `id` of the existing resource. Reuse it rather than creating another.
   After a lost response, read before retrying. Duplicate comparison of recipe
   creation uses all validated fields within the same coffee.
6. DELETE `/recipes/{recipe_id}` removes one recipe. DELETE `/coffees/{coffee_id}`
   removes the coffee AND all of its active recipes. Only delete when requested
   by the user. DELETE needs no body or Content-Type.
7. Confirm the result with a GET. Every changed state is in `/history` (last 20).
   Writes return `{ "ok": true, "revision": "...", "data": {...} }`;
   deletions return `data: null`. Unchanged writes do not add history entries.

The PWA sees these changes on its next successful synchronization (manual,
return to app, or every 30 seconds while active). If a device has unsynced local
changes, the existing conflict screen protects both versions; agent writes do
not bypass it. Agent calls require an online server. History restore remains
in the app; do not use internal `/api/sync` to replace the collection.

## Endpoints (relative to /api/v1)

| Method | Path | Behavior |
| --- | --- | --- |
| GET | /state | Collection with revision |
| GET / POST | /coffees | List with nested recipes / create coffee |
| GET / PATCH / PUT / DELETE | /coffees/{coffee_id} | Read / update / update / delete coffee |
| GET / POST | /coffees/{coffee_id}/recipes | List / add recipe |
| GET / PATCH / PUT / DELETE | /recipes/{recipe_id} | Read / update / replace / delete recipe |
| GET / POST | /grinders | Read / save current physical grinder settings (independent revision) |
| GET | /history | Version summaries |
| GET | /history/{version_id} | Historical collection |

Lists return JSON arrays; individual reads return the resource directly.
`GET /recipes/{recipe_id}` also includes `coffee_id`. PATCH preserves omitted
fields. Both coffee PUT and PATCH preserve omitted metadata. Recipe PUT is a
replacement: volume, dose, temperature are mandatory and omitted optional fields
reset. Recipe PATCH replaces supplied `pours` or `steps` arrays in full.
Reassigning a recipe to another coffee is not supported.

## Data

Coffee: required `name` (1–120 characters); optional `description` (max 1000),
`accent` (`rose`, `lime`, `sky`, `honey`, `lavender`, default `rose`), and text
fields `roaster`, `country`, `region`, `variety`, `process`, `roast`, `tasting_notes`
(max 300 each). Unknown metadata should be empty; never infer origin or roaster
from the name. `recipes` is not accepted on coffee writes: use the recipe endpoint.

Recipe: required numeric `volume` (water in g, 1–10000), `dose` (coffee in g,
0.1–1000), `temperature` (°C, 1–100). Optional strings: `grind`, `dripper`, `method`,
`duration`, `yield` (max 300), `notes` (max 10000). `grind` includes grinder name,
setting and reference point, e.g. `Timemore C3S · 17 klików od zera`.
`yield` is finished beverage, not water; do not invent it or scale recipes without
being asked. Missing optional strings default to empty, arrays to `[]`.

`pours`: max 50 objects `{ "time": "0:00–0:15", "amount": 75 }`. Time is a
nonblank string (max 100); amount is newly added water (0.1–10000 g), not cumulative.
If nonempty, amounts must sum to volume (tolerance 0.01 g). Keep final drawdown in
`duration` or `steps`, not a pour. `steps`: max 100 nonblank strings, max 3000 each.
When changing volume, update pours in the same request if needed.
All text fields accept plain text; unknown top-level write fields are rejected.
Limits on creation: 1000 coffees, 100 recipes per coffee; body <= 2 MB.
The full collection must stay within 1.8 MB for PWA synchronization.
For file-import JSON/Markdown rules, see `/ai-instructions.md`.

## Examples

Store `COFFEE_URL` (app origin, without trailing slash) and `COFFEE_API_TOKEN`
in your agent environment. These are client-side variable names; the server uses
`APP_API_TOKEN`. They must hold the same token value.

```sh
# Discover existing coffees and read ETag headers.
curl -i "$COFFEE_URL/api/v1/coffees" \
  -H "Authorization: Bearer $COFFEE_API_TOKEN"

# Create metadata; extract data.id from the response.
curl "$COFFEE_URL/api/v1/coffees" \
  -H "Authorization: Bearer $COFFEE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Moja nowa kawa","accent":"lime","country":"Etiopia","process":"Natural"}'

# Replace 123 with that returned coffee ID.
curl "$COFFEE_URL/api/v1/coffees/123/recipes" \
  -H "Authorization: Bearer $COFFEE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"volume":500,"dose":30,"temperature":91,"method":"4:6","grind":"Timemore C3S · 17 klików od zera","pours":[{"time":"0:00–0:15","amount":75},{"time":"0:50–1:07","amount":125},{"time":"1:40–1:55","amount":100},{"time":"2:30–2:45","amount":100},{"time":"3:20–3:35","amount":100}],"steps":["Przepłucz filtr i rozgrzej dripper."]}'

# Replace 456 with the returned recipe ID; revision with the latest GET's ETag.
curl -X PATCH "$COFFEE_URL/api/v1/recipes/456" \
  -H "Authorization: Bearer $COFFEE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'If-Match: "LATEST_REVISION_FROM_ETAG"' \
  -d '{"grind":"Timemore C3S · 18 klików od zera"}'
```

Errors are JSON `{ "error": "message" }` (Polish messages): 400 invalid fields,
401 missing/invalid token, 403 cross-site browser write, 404 missing resource,
409 duplicate (also `id`), 412 stale revision, 413 invalid body size,
415 non-JSON write, 503 agent API disabled. Do not log secrets in error reports.


## Current grinder memory

`GET /grinders` returns `{ "grinders": [{ "name": "Timemore C3S", "setting": "17 klików od zera" }], "revision": "..." }`.
`POST /grinders` accepts the same shape and replaces the memory list atomically.
Always include the revision from a fresh read and preserve other grinders.
It uses a separate revision from the recipe collection, including its own ETag
and optional If-Match. A stale revision returns 409 with the current grinders
and revision (If-Match mismatch returns 412). Read before retrying.
The success response is the memory snapshot directly, not a `{data:...}` wrapper.
Maximum 20 unique grinder names, name 1–120 and setting 1–180 characters.
The owner can adjust this memory offline; conflicting device writes require
reconciliation. This memory is not part of coffee import/export or recipe history.

Only change memory when the user confirms the physical grinder has been adjusted.
Reading/selecting/adding a recipe must never automatically change grinder memory.
For reliable recipe matching use grind text `MODEL · SETTING`, preserving the exact
reference point. The app compares remembered settings with recipe requirements;
it cannot read a physical grinder. An unset/ambiguous model is not a match.
