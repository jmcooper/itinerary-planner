# Users, Auth, and Trip Sharing — Design

Adds user accounts, sign in/out, private/public itineraries, and per-user sharing to the
itinerary builder. Extends the design in
[2026-07-02-itinerary-builder-design.md](2026-07-02-itinerary-builder-design.md).

## Requirements (from the request)

- Private and public itineraries.
- Users with sign in / sign out; links right-aligned in the site header.
- Secure: JWT + hashed passwords; no API path may ever return password material.
- Home page shows three sections in order: **My Trips**, **Trips Shared with Me**,
  **Public Trips**.
- Sharing: a searchable dropdown listing all usernames — click to browse the full list,
  or type to filter/auto-complete and click to select.

## Auth design

- **Password hashing**: `scrypt` from `node:crypto` (N=16384, r=8, p=1), 16-byte random
  salt per user, 64-byte key, compared with `timingSafeEqual`. No external hashing dep.
- **JWT**: signed with `jsonwebtoken` (HS256), payload `{ sub: username }`, 7-day expiry.
  The signing secret comes from `JWT_SECRET` env or is generated once and persisted to
  `<dataDir>/jwt-secret` (0600-equivalent), so tokens survive restarts without a
  hardcoded secret.
- **Transport**: the JWT is set as an `httpOnly`, `SameSite=Strict` cookie named `token`
  (`Secure` when `COOKIE_SECURE=1`). httpOnly keeps the token away from XSS;
  SameSite=Strict mitigates CSRF for this JSON API. The token is never included in a
  response body.
- **User storage**: one file per user at `<dataDir>/users/<username>.json`:
  `{ username, salt, hash, createdAt }`. A separate subdirectory guarantees user files
  can never appear in the trip listing. Usernames are the stable user id.
- **Username rules**: lowercased, `/^[a-z0-9][a-z0-9_-]{2,29}$/` (3–30 chars) — also makes
  the filename path-safe. Password: minimum 8 characters.
- **No-leak guarantee**: routes only ever serialize `{ username }` (plus trip data).
  `salt`/`hash` live only in the storage layer; a test asserts no auth/user/trip response
  body contains `salt`, `hash`, or `password` keys.

## API

Auth:

- `POST /api/auth/register` `{username, password}` → 201 `{username}` + sets cookie
- `POST /api/auth/login` `{username, password}` → 200 `{username}` + sets cookie
  (401 on bad credentials, same message for unknown user vs wrong password)
- `POST /api/auth/logout` → 204, clears cookie
- `GET /api/auth/me` → `{username}` or `{username: null}` when signed out
- `GET /api/users` → `[username, ...]` (signed-in only; used by the share dropdown)

Trips (changed):

- Trip document gains `ownerId` (username), `visibility: 'private' | 'public'`
  (default `private`), `sharedWith: [username, ...]`.
- `GET /api/trips` → `{ mine: [...], shared: [...], public: [...] }` summaries.
  Anonymous users get only `public`. `public` excludes trips already in `mine`/`shared`.
- `POST /api/trips` → requires auth; sets `ownerId`, `visibility: 'private'`,
  `sharedWith: []`.
- `GET /api/trips/:id` → allowed for owner, shared users, or anyone if public; otherwise
  **404** (not 403, to avoid leaking trip existence). Response includes computed
  `isOwner` and `canEdit` for the client.
- `PUT /api/trips/:id` → owner or shared users may edit content (name, dates, days);
  only the owner may change `visibility`/`sharedWith`. `sharedWith` entries must be
  existing usernames; the owner is never in `sharedWith`.
- `DELETE /api/trips/:id` → owner only.
- Image routes follow trip permissions: read = can view, write = can edit.
- **Legacy trips** (no `ownerId`): treated as public; any signed-in user may edit or
  delete them.

## Client

- `AuthContext` provider fetches `/api/auth/me` on load; exposes `user`, `signIn`,
  `signUp`, `signOut`. Cookie handling is automatic (`credentials: 'same-origin'`).
- **Header**: brand left; right-aligned auth area — signed out: "Sign In" link; signed
  in: username + "Sign Out" button.
- `/signin` page with sign-in/sign-up toggle.
- **HomePage**: create form (requires sign-in; anonymous users see a sign-in prompt),
  then sections My Trips, Trips Shared with Me, Public Trips. Empty sections show a
  short note; Shared with Me is hidden entirely when signed out.
- **TripPage**: owner sees a Sharing panel — visibility toggle (Private/Public) and a
  searchable combobox of all usernames (click shows full list, typing filters,
  click/Enter selects) with selected users shown as removable chips. Non-editors get a
  read-only view: `canEdit` is threaded to `DayView`/`ItineraryRow` to hide edit,
  import, image-upload, and delete affordances.

## Decisions taken (request was open)

- Shared users can **edit** trip content (collaborative), but only the owner can delete,
  share, or change visibility. This keeps the trip page UI uniform for owner + shared.
- New trips default to private.
- Username = user id (simple, human-readable, matches the sharing-by-username UI).
- No rate limiting / account lockout — out of scope for this file-backed app, noted as
  future work.

## Testing

- Server (`node:test` + supertest): register/login/logout/me lifecycle; wrong-password
  and duplicate-username failures; cookie flags; trips authorization matrix (anonymous /
  owner / shared / other user × list, get, put, delete, images); visibility and sharing
  updates; owner-only share/visibility; the password-material leak test.
- Client: existing vitest parse tests must keep passing; combobox filter logic is a pure
  function with unit tests.
