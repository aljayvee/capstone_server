# Realtime Database authentication and rules

`database.rules.json` is the ruleset for `capstonedata-3589c-default-rtdb`. It lives
here, in version control, because the previous ruleset existed only inside the
Firebase Console: when it changed, rider tracking, both chat channels and customer
location sharing stopped at once, and nothing in any repository recorded what the
rules had been or what the clients needed from them.

## What changed, and why it had to

Before this, all three clients opened the Realtime Database with no identity:

```ts
const app = initializeApp({ databaseURL, projectId });
export const database = getDatabase(app);   // no auth, anywhere
```

That left exactly two possible rulesets. Wide open, which publishes every rider's
live GPS and every chat message to anyone holding the database URL — and that URL
ships inside the web bundle and both APKs, so "anyone" is the internet. Or closed,
which is what was in force when this was written: every path answering
`PERMISSION_DENIED`, with no client able to say so out loud.

Now the server mints a Firebase custom token for an already-authenticated session
(`POST /api/auth/firebase-token`), each client exchanges it for a Firebase session,
and the rules can name who is allowed to do what.

MariaDB remains the identity authority. Nobody signs in to Firebase; they sign in
once, the normal way, and this re-states that proven identity in a form the rules
can read.

## The uid contract

`src/lib/firebaseAdmin.ts` builds every uid, and the rules parse it back:

| Role              | uid             |
| ----------------- | --------------- |
| RIDER             | `rider_<id>`    |
| CUSTOMER          | `customer_<id>` |
| OWNER, DISPATCHER | `staff_<id>`    |

The prefixes are load-bearing. Staff and riders are rows in `users`, customers are
rows in `customer_accounts`, and both id sequences start at 1 — an unprefixed
numeric uid would make customer 3 and rider 3 the same Firebase principal, and
`riders/3` would become writable by a customer. Change `firebaseUidFor()` and this
file together or not at all.

Two custom claims ride along: `role` and `appUserId`.

## What the rules enforce

- **`riders/$riderId`** — writable only by `rider_$riderId`, so a rider can move
  their own pin and nobody else's. Readable as a whole collection only by OWNER and
  DISPATCHER; any authenticated user may read a single rider node, which is what
  lets a customer watch the rider carrying their errand.
- **`locations/customers/$customerId`** — writable only by that customer, readable
  by that customer and by staff.
- **`chats/$errandId`** (customer and dispatcher). Readable and writable by OWNER, and
  by the two uids in `chat_access/$errandId`: the errand's customer and the dispatcher
  who claimed it (since 2026-10-07). The server writes that node through the Admin SDK
  (`src/lib/chatAccess.ts`): on errand creation, on claim, and on release. Clients cannot
  read or write it. `npm run chat-access:backfill` rewrites it for every errand from
  MariaDB, and must run before these rules are published anywhere new.
- **`rider_chats/$riderId`** (the old shared rider thread). The rider and staff only;
  customers could read it until 2026-10-07.
- **`rider_threads/$riderId/$staffUid`**, **`rider_inbox/$riderId/$staffUid`**,
  **`dispatcher_inbox/$staffUid/$riderId`**. One private conversation per dispatcher and
  rider, readable by those two (owners read all). The inboxes hold one summary row per
  conversation so neither side downloads every message to draw its list.
- **`config/riderChatMode`**: `shared` (or missing) or `threads`. Read by the web portal
  and the rider app; written only with the Admin SDK.

Coordinate fields are range-validated, so a malformed write cannot put a rider in
the ocean. Validation is deliberately light elsewhere: a `.validate` rule that is
too strict fails writes in production the same way a missing rule does.

## Why chat access is a server-written list (2026-10-07)

Chat used to be gated on authentication plus knowledge of the errand id, on the
reasoning that UUIDs cannot be guessed. They did not need guessing: the API broadcast
every `order:new`/`order:updated` event, errand included, to every connected app, and
the customer app opened the chat of every errand it heard about. Customers received
each other's dispatcher messages as notifications. The broadcasts are now scoped to
each errand's people, and the rules no longer trust knowledge of an id.

## Moving rider chat to private threads

Rider apps from before 2026-10-07 know only `rider_chats/$riderId`. The switch is one
value, so both apps move at once:

1. Ship the rider app that reads `config/riderChatMode`, and wait until every rider has it.
2. Set `config/riderChatMode` to `threads` (Admin SDK or the console).
3. Tighten `rider_chats/$riderId` to the rider and OWNER only: it then holds history that
   several dispatchers wrote, which no single dispatcher owns.

## Who may read a rider's position (2026-10-07)

`riders/$riderId` as a whole collection is staff only. One rider's node is readable by
that rider, staff, and the customers listed in `rider_watchers/$riderId/<customerUid>`:
those whose errand the rider is working now (ASSIGNED or IN_TRANSIT). Until this date
any signed-in user could read any rider.

`src/lib/riderWatch.ts` writes the list. It rebuilds the whole node from MariaDB about
two seconds after any errand change and once a minute (`jobs/riderWatchReconcile.ts`),
so an errand finished by any path drops out on its own. A new assignment is also
granted before its socket event goes out, so the customer's map is not refused when
it opens. The customer app retries a refused listen a few times as well.

## Applying

The rules are not deployed automatically. Either paste the contents of
`database.rules.json` into **Firebase Console → Realtime Database → Rules → Publish**,
or, with the Firebase CLI configured for this project:

```bash
firebase deploy --only database
```

## Server configuration

Minting requires a service account, which is a private key with full project
authority. It is not the public client config in `google-services.json`, and it must
never be committed.

1. Firebase Console → Project settings → Service accounts → **Generate new private key**.
2. Put the downloaded JSON somewhere outside the repository on the server, readable
   only by the service user.
3. Point the server at it:

```
FIREBASE_SERVICE_ACCOUNT_PATH=/etc/sugo/firebase-service-account.json
```

`FIREBASE_SERVICE_ACCOUNT_JSON` takes the same JSON inline, for environments that
only pass environment variables.

Leaving both blank disables token minting. The API keeps running and the real-time
surfaces degrade with a visible error, which is intentional: a misconfigured
convenience must not take the server down with it.
