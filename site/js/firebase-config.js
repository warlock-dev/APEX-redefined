// Your Firebase web configuration. Copy it from the Firebase console:
// Project settings → Your apps → Web app → SDK setup and configuration.
// These values are identifiers, not secrets: security comes from the Firestore rules and the sign-in.
// Until every value is filled in, APEX runs on this device only and says so on the More page.

export const firebaseConfig = {
  apiKey: "AIzaSyDo_QCsQ2kJd5WYK-Dn8wE3Pwg26HUoVJI",
  authDomain: "apex-ba40d.firebaseapp.com",
  databaseURL: "https://apex-ba40d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "apex-ba40d",
  storageBucket: "apex-ba40d.firebasestorage.app",
  messagingSenderId: "93629900203",
  appId: "1:93629900203:web:b3dfadb8c1d2af4b641eee"
};

export const isFirebaseConfigured = () => Object.values(FIREBASE_CONFIG).every((v) => v && !/REPLACE/.test(v));
