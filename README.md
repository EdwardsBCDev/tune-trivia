# Tune Trivia

A multiplayer music guessing game for family and friends. Players submit songs for a prompt, listen to the anonymous playlist, then guess who picked each track.

## Run Locally

Prerequisite: Node.js

1. Install dependencies:
   `npm install`
2. Copy `.env.example` to `.env.local` and fill in the Firebase, Gemini, and optional Spotify values.
3. Run the app:
   `npm run dev`

## Required Firebase Setup

The game stores all multiplayer state in Firebase Realtime Database under `/rooms`.

For private family/friends play, publish the rules in `database.rules.json` to Firebase Realtime Database:

```json
{
  "rules": {
    "rooms": {
      ".read": true,
      ".write": true
    }
  }
}
```

These rules are intentionally simple and scoped to rooms. They are suitable for low-risk private use, not a public app with untrusted users.

If hosting with Coolify or another static host, make sure these variables are configured at build time:

- `GEMINI_API_KEY`
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_DATABASE_URL`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_SPOTIFY_CLIENT_ID` optional, can also be entered in the in-app settings

## Build

```bash
npm run build
```
