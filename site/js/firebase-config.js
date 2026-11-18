// Firebase settings for the web app. These values identify your project; they are not secrets.
// Access is controlled by Google sign-in and the Firestore rules (firestore.rules), not by hiding these values.

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDo_QCsQ2kJd5WYK-Dn8wE3Pwg26HUoVJI",
  authDomain: "apex-ba40d.firebaseapp.com",
  projectId: "apex-ba40d",
  storageBucket: "apex-ba40d.firebasestorage.app",
  messagingSenderId: "93629900203",
  appId: "1:93629900203:web:b3dfadb8c1d2af4b641eee"
};

// True only when every value has been filled in. Until then the app runs without sign-in.
export const isFirebaseConfigured = () =>
  Object.values(FIREBASE_CONFIG).every((v) => v && !/REPLACE/.test(v));
