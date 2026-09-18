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
- **`chats/$errandId`, `rider_chats/$errandId`** — authentication required. The
  role-named subtrees are pinned to the matching role, so a customer cannot write
  the dispatcher's presence or typing indicator and vice versa.

Coordinate fields are range-validated, so a malformed write cannot put a rider in
the ocean. Validation is deliberately light elsewhere: a `.validate` rule that is
too strict fails writes in production the same way a missing rule does, and this
ruleset is a first tightening rather than a final one.

## Known gap, deliberately left open

Chat access is gated on authentication plus knowledge of the errand id. Errand ids
are UUIDs, so they cannot be enumerated, but a signed-in user who obtains one can
read that conversation. Closing this properly needs a server-written
`participants` node under each chat, populated when the errand is created and when
a rider is assigned, with the rules checking membership against it.

That is a backend change to errand creation and assignment rather than a rules
change, so it is recorded here rather than half-done. The current state is still a
large improvement on the alternative it replaces: an unauthenticated read of every
conversation in the system.

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
