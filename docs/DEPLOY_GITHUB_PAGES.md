# Deploy APEX to GitHub Pages

The site is plain files in the `site/` folder. GitHub Pages serves them. A workflow in `.github/workflows/pages.yml` runs the tests and then publishes `site/`.

## 1. Create the repository

1. On GitHub, create a new **empty** repository, for example `apex`. Keep it private if you like; GitHub Pages on a private repo needs a paid GitHub plan, so public is simplest.
2. Upload the contents of the zip, **including** the hidden `.github` folder. Do not upload `node_modules` (the zip does not contain it).

   From a terminal, in the unzipped folder:

   ```sh
   git init -b main
   git add .
   git commit -m "APEX"
   git remote add origin https://github.com/<your-username>/apex.git
   git push -u origin main
   ```

   Or drag the files into the repository page on GitHub. Check that `.github/workflows/pages.yml` is in the repository.

## 2. Turn on GitHub Pages

1. Open the repository's **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.

## 3. Let the workflow run

1. Open the **Actions** tab. The workflow named **Pages** runs on every push to `main`.
2. It first runs the unit tests (`npm test`). If they fail, nothing is published.
3. Then it publishes `site/`.
4. When it finishes, **Settings → Pages** shows the address, normally:

   ```
   https://<your-username>.github.io/apex/
   ```

## 4. Connect Firebase to that address

Sign-in only works from domains Firebase trusts. Follow step 3 of `docs/FIREBASE_SETUP.md` and add `<your-username>.github.io` under **Authorized domains**. Only the host name, with no path.

Until Firebase is set up, the app runs fully on the device. The More screen says sync is not set up yet.

## Checking the live site

- Open the address on your laptop and on your phone.
- On the phone, use the browser's "Add to Home Screen" so APEX opens like an app. It keeps working offline with the last version it loaded.
- After you change the app, the new version appears on the next visit. Close and reopen the app once if an old version lingers.

## Running it on your own computer

No install is needed to use it: open `site/index.html` through a local server, for example:

```sh
npm start          # serves site/ and prints the address to open in your browser
```

To run the tests:

```sh
npm test           # unit, store, sync and calendar tests (no browser needed)
npm run test:e2e   # browser tests; needs Playwright and a Chromium browser installed
```
