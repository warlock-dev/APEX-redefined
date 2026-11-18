// The only file that talks to Firebase. Everything else uses the small interface returned here, so the sync
// engine can be tested against an in-memory copy (see tests/fake-backend.mjs).
//
// The Firebase SDK is loaded from Google's CDN at a pinned version. Only the browser loads it, so nothing
// in the repository needs npm to run.

export const SDK_VERSION = '10.14.1';
const SDK = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const COLLECTIONS = ['tracks', 'nodes', 'tasks', 'days'];

/** Strips anything Firestore would refuse (undefined values) and returns a plain copy. */
export const plain = (record) => JSON.parse(JSON.stringify(record));

export async function createFirebaseBackend(config) {
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = appMod.initializeApp(config);
  const auth = authMod.getAuth(app);
  const db = fsMod.getFirestore(app);

  return {
    /** Calls back with { uid, email, name } or null whenever the signed-in state changes. */
    onUser(cb) {
      return authMod.onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email || '', name: u.displayName || '' } : null));
    },
    /** Google sign-in. Asks for calendar access too, so reminders can be written. Returns the Calendar token or null. */
    async signIn() {
      const provider = new authMod.GoogleAuthProvider();
      provider.addScope(CALENDAR_SCOPE);
      const result = await authMod.signInWithPopup(auth, provider);
      const cred = authMod.GoogleAuthProvider.credentialFromResult(result);
      return { calendarToken: cred?.accessToken || null };
    },
    signOut: () => authMod.signOut(auth),
    /** Listens to one collection of the signed-in person's data. Every change arrives as the full list. */
    subscribe(uid, name, cb) {
      const ref = fsMod.collection(db, `users/${uid}/${name}`);
      return fsMod.onSnapshot(ref, (snap) => cb(snap.docs.map((d) => d.data())), (err) => cb(null, err));
    },
    write(uid, name, record) {
      return fsMod.setDoc(fsMod.doc(db, `users/${uid}/${name}`, record.id), plain(record));
    },
  };
}
