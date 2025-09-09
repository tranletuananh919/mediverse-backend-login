import express from "express";
import mongoose from "mongoose";
import session from "express-session";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as FacebookStrategy } from "passport-facebook";
import dotenv from "dotenv";

dotenv.config();
const app = express();

// MongoDB Atlas
mongoose.connect(process.env.MONGO_URI);

// User model
const UserSchema = new mongoose.Schema({
  provider: String,
  providerId: String,
  email: String,
  name: String,
});
const User = mongoose.model("User", UserSchema);

// Session
app.use(session({ secret: "secret", resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());

// Passport serialize
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  const user = await User.findById(id);
  done(null, user);
});

// Google OAuth strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/auth/google/callback",
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

// Facebook OAuth strategy
passport.use(
  new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_APP_ID,
      clientSecret: process.env.FACEBOOK_APP_SECRET,
      callbackURL: "/auth/facebook/callback",
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

// Routes
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => res.redirect("https://your-frontend.netlify.app/")
);

app.get("/auth/facebook", passport.authenticate("facebook", { scope: ["email"] }));
app.get("/auth/facebook/callback",
  passport.authenticate("facebook", { failureRedirect: "/login" }),
  (req, res) => res.redirect("https://your-frontend.netlify.app/")
);

app.listen(process.env.PORT || 5000, () => console.log("Server running"));