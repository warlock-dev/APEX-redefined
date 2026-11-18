// Your Firebase web configuration. Copy it from the Firebase console:
// Project settings → Your apps → Web app → SDK setup and configuration.
// These values are identifiers, not secrets: security comes from the Firestore rules and the sign-in.
// Until every value is filled in, APEX runs on this device only and says so on the More page.

export const FIREBASE_CONFIG = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.appspot.com',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
};

export const isFirebaseConfigured = () => Object.values(FIREBASE_CONFIG).every((v) => v && !/REPLACE/.test(v));
