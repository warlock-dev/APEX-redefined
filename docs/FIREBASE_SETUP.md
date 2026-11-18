# Firebase setup (sign-in, cloud copy, Google Calendar)

APEX works fully without this. Turn it on when you want the same data on your phone and laptop, and review dates in your Google Calendar.

What Firebase does here:

- **Google sign-in** (Firebase Authentication). The same sign-in asks for permission to write calendar events.
- **Firestore** keeps one copy of your data per person, under `users/<your uid>/`. The security rules in `firestore.rules` let only you read and write it.
- **GitHub Pages** still hosts the app. Firebase only stores data and signs you in.

Nothing in this setup is a secret. The Firebase web config (apiKey and the rest) is public by design, and access is controlled by the sign-in and the rules. It is safe to commit it.

Time needed: about 20 minutes. Everything below is done in your browser at the Firebase and Google Cloud consoles.

---

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and choose **Add project**.
2. Name it (for example `apex-personal`). Google Analytics is not needed; you can turn it off.
3. Wait for the project to be created.

## 2. Register a web app and copy its settings

1. On the project overview, click the **</>** (Web) icon.
2. Give it a nickname (`apex-web`). Do **not** tick "Firebase Hosting". Click **Register app**.
3. You will see a block like this:

   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "apex-personal.firebaseapp.com",
     projectId: "apex-personal",
     storageBucket: "apex-personal.firebasestorage.app",
     messagingSenderId: "123456789012",
     appId: "1:123456789012:web:abcdef123456"
   };
   ```

4. Open `site/js/firebase-config.js` in the repository and replace each `REPLACE_ME_...` value with the matching value. Keep the quotes.
5. Save, commit and push. The app shows the sign-in section only when all six values are filled in.

## 3. Turn on Google sign-in

1. In the Firebase console, open **Build → Authentication** and click **Get started**.
2. Under **Sign-in method**, choose **Google**, switch it on, pick a support email, and save.
3. Open **Settings → Authorized domains**. `localhost` is already there. Click **Add domain** and enter your GitHub Pages host **without** a path or `https://`:

   ```
   <your-github-username>.github.io
   ```

   Without this, sign-in on the live site is refused.

## 4. Create the database

1. Open **Build → Firestore Database** and click **Create database**.
2. Choose the location closest to you (it cannot be changed later). Start in **production mode**; the rules below replace the default ones.

## 5. Publish the security rules

Pick one of the two ways.

**Option A: in the console.** Open **Firestore → Rules**, delete what is there, paste the full contents of `firestore.rules`, and click **Publish**.

**Option B: with the Firebase CLI** (if you have Node.js):

```sh
npm install -g firebase-tools
firebase login
firebase use --add        # choose the project you created, give it the alias "default"
firebase deploy --only firestore:rules,firestore:indexes
```

The rules allow each person to read and write only their own data, only the four APEX collections, and nothing can be deleted (APEX marks things as deleted instead, so the other devices learn about it).

## 6. Turn on the Google Calendar API

Calendar reminders need the Calendar API in the same Google Cloud project as Firebase.

1. Open <https://console.cloud.google.com>. At the top, select the project with the same name as your Firebase project.
2. Go to **APIs & Services → Library**, search for **Google Calendar API**, open it, and click **Enable**.

## 7. Set up the OAuth consent screen

1. In the same Google Cloud project, open **Google Auth Platform** (older name: **APIs & Services → OAuth consent screen**).
2. Under **Branding**, set the app name to `APEX` and add your support email.
3. Under **Audience**, choose **External**.
4. Under **Data access**, add the scope `https://www.googleapis.com/auth/calendar.events`. Google calls this a *sensitive* scope.
5. Under **Audience → Test users**, add the Google account you will use. While the app is in **Testing**, only listed test users can grant calendar access, and Google may show an "unverified app" warning. That is expected for a personal app.

If you later want other people to use APEX with calendar reminders, you would need to submit the app for Google's verification. Sync works for anyone who signs in, even without the calendar.

## 8. Try it

1. Open your site (see `docs/DEPLOY_GITHUB_PAGES.md`) and go to **More → Account and sync**.
2. Click **Sign in with Google**. Choose your account and accept the calendar permission. If you untick the calendar box on Google's screen, sign-in still works but no review dates are added.
3. You should see "Signed in as …". Then **Google Calendar: … added** appears for any topic with a review date.
4. Open the same site on your phone, sign in, and check that your topics and tasks appear.

### Things to know

- **Calendar access lasts about an hour.** Google does not give a browser app a token that renews by itself, and APEX keeps the token in memory only. After a reload, tap **Connect Google Calendar** (or **Refresh calendar access**) again. Sync itself does not need this and keeps working.
- **Calendar events are created by the first device that sees the topic.** The event id is stored on the topic, so the other devices update the same event. If two devices create an event before they have synced, you may see a duplicate titled "APEX review". Delete the extra one by hand.
- **Events you delete in Google Calendar are not recreated** until the topic's review date changes. Deleting an event by hand is a way to say "not this one".
- **Turning the calendar box off** stops new events. It does not delete existing ones.

## If something goes wrong

| What you see | What to check |
| --- | --- |
| "Sign-in failed" or a blank popup | Is `<username>.github.io` in **Authorized domains**? Did you save `firebase-config.js` with the real values? |
| Sign-in works but data does not sync | Is the database created and are the rules published? Open the browser console: a "permission-denied" message means the rules do not match the signed-in user. |
| "Google did not grant calendar access" | Tick the calendar checkbox on Google's permission screen. Check you are a listed test user. |
| "Google Calendar needs reconnecting" | Normal after about an hour or a reload. Tap **Connect Google Calendar**. |
| Calendar says "not updated yet" | Usually a short network problem. APEX retries about a minute later. |
