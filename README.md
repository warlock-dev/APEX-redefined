# APEX

A personal app for three things: getting through the day, working through an exam syllabus or a new skill topic by topic, and reviewing what you learned on a schedule. It works on its own in the browser. Add Firebase and it keeps the same data on your phone and laptop, and can put review dates into your Google Calendar.

## What it does

- **Today.** Quick-add a task ("read chapter 3 30m"), start and stop a timer (no fixed work hours), finish, and plan tomorrow. Unfinished tasks carry over to the next day and remember where they came from.
- **Tracks.** An exam or a skill is a track. Paste a syllabus as an indented list and each line becomes a topic. Learn a topic and it is scheduled for review at 1, 3, 7, 15, 30 and then 60 days; topics you have reviewed five times are marked mastered.
- **Close.** End the day with an outcome, a note on why it went the way it did, and one thing for tomorrow.
- **Progress.** Your week, your tracks, and what is due.
- **More.** Sign-in and sync, calendar reminders, backup and restore, erase.

Design choices are documented in `docs/RESEARCH.md`: short implementation intentions, defaults that remove decisions, spaced review, and no streaks or guilt.

## Where the data lives

- Every change is saved in this browser first, so the app works offline.
- With sign-in, the same data is kept in your own Firestore area and merged between devices by record. The newest version of each record wins; nothing is overwritten by an older copy.
- Backups are a JSON file you download from **More**. Restore merges or replaces.
- Nothing is sent to any AI service. There is no AI API in the app.

## Files

```
site/                  the app (this is what GitHub Pages serves)
  index.html, sw.js    page shell and offline cache
  css/app.css          styles
  js/model.js          the rules: review ladder, parsing, merging, validation
  js/store.js          all changes to the data go through here
  js/app.js            screens and wiring
  js/sync.js           keeps this device and the cloud in step
  js/backend.js        the Firebase adapter (sign-in and Firestore)
  js/calendar.js       Google Calendar review events
  js/firebase-config.js  your Firebase settings (public values, see docs)
tests/                 unit, store, sync, calendar and browser tests
docs/                  FIREBASE_SETUP.md, DEPLOY_GITHUB_PAGES.md, RESEARCH.md
firebase.json          points the Firebase CLI at the rules
firestore.rules        who can read and write what
.github/workflows/     runs the tests and publishes site/ to GitHub Pages
```

## Getting started

1. Read `docs/DEPLOY_GITHUB_PAGES.md` to publish the app, or open `site/index.html` through a local server (`npm start`).
2. Optional: follow `docs/FIREBASE_SETUP.md` to turn on sign-in, sync and calendar reminders.

## Development

```sh
npm test           # unit, store, sync and calendar tests
npm run test:e2e   # browser tests (needs Playwright and Chromium)
```

No build step, no runtime dependencies. The Firebase SDK is loaded from Google's CDN only when Firebase is configured.
