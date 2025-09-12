import express from "express";
import mongoose from "mongoose";
import session from "express-session";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as FacebookStrategy } from "passport-facebook";
import dotenv from "dotenv";
import MongoStore from "connect-mongo";

dotenv.config();
const app = express();

// ====================== DATABASE ======================
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log("✅ MongoDB connected"))
.catch(err => console.error("❌ MongoDB error:", err));

// ====================== USER MODEL ======================
const UserSchema = new mongoose.Schema({
  provider: String,
  providerId: String,
  email: String,
  name: String,
});
const User = mongoose.model("User", UserSchema);

// ====================== SESSION ======================
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: true,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: "sessions"
  })
}));

app.use(passport.initialize());
app.use(passport.session());

// ====================== PASSPORT ======================
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  const user = await User.findById(id);
  done(null, user);
});

// ====================== GOOGLE STRATEGY ======================
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.BASE_URL + "/auth/google/callback",
    },
    async (accessToken, refreshToken, profile, done) => {
      let user = await User.findOne({ provider: "google", providerId: profile.id });
      if (!user) {
        user = await User.create({
          provider: "google",
          providerId: profile.id,
          email: profile.emails[0].value,
          name: profile.displayName,
        });
      }
      return done(null, user);
    }
  )
);

// ====================== FACEBOOK STRATEGY ======================
passport.use(
  new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_APP_ID,
      clientSecret: process.env.FACEBOOK_APP_SECRET,
      callbackURL: process.env.BASE_URL + "/auth/facebook/callback",
      profileFields: ["id", "displayName", "emails"],
    },
    async (accessToken, refreshToken, profile, done) => {
      let user = await User.findOne({ provider: "facebook", providerId: profile.id });
      if (!user) {
        user = await User.create({
          provider: "facebook",
          providerId: profile.id,
          email: profile.emails?.[0]?.value || "",
          name: profile.displayName,
        });
      }
      return done(null, user);
    }
  )
);

// ====================== ROUTES ======================
app.get("/", (req, res) => {
  res.send("✅ Backend is running...");
});

// Google
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => res.redirect("https://kat-mediverse.netlify.app/")
);

// Facebook
app.get("/auth/facebook", passport.authenticate("facebook", { scope: ["email"] }));
app.get("/auth/facebook/callback",
  passport.authenticate("facebook", { failureRedirect: "/login" }),
  (req, res) => res.redirect("https://kat-mediverse.netlify.app/")
);

// ====================== START SERVER ======================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
