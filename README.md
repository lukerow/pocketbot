<p align="center"><img src="icons/icon-192.png" width="96" alt="PocketBot icon"></p>

<h1 align="center">PocketBot</h1>
<p align="center"><b>Live tempo for drummers.</b> Set a target, play, and see if you're rushing or dragging.</p>
<p align="center"><a href="https://YOUR-USERNAME.github.io/pocketbot/"><b>▶ Open PocketBot</b></a></p>

---

## Why I made this

I kept running into the same problem: drummers drifting out of time. Songs speed up in the chorus, slow down in the verse, and by the end you're nowhere near where you started.

The usual fix is a click track, but not every drummer likes playing to one. It takes in-ear monitoring, it can make the groove feel stiff, and it's easy to switch off and forget.

**PocketBot is a different approach. It listens instead of clicking.** Put your phone near the kit and it shows your live BPM against the tempo you set, so you can see when you're drifting and correct it yourself. No headphones, and nothing to play along to.

I vibe coded it with Claude: I described the problem and the feel I wanted, then tested and refined it until it worked for me.

## What it does

- **Live BPM** in huge numbers you can read from behind the kit
- **RUSHING / DRAGGING / LOCKED IN**, plus a meter showing how far off you are
- **Set your tempo** by swiping, tapping the number in time, or using − / ＋
- **Time signatures:** 2/4, 3/4, 4/4, 5/4, 6/8, 7/8, with beat numbers that show where "1" is
- **Beat flash:** a silent visual metronome with a one-bar count-in, in four styles
- **Handles real playing:** half-time and double-time feels, fills, syncopation and short breaks
- **Favourites** that save your tempo and time signature together, for setlists
- **Tempo graph** after each session, with tips for next time
- **Chair mode** 🪑: an optional game mode. Drift too far and a chair comes flying.

## How to use it

1. Open the link on your phone (iPhone or Android).
2. Optional: tap **Share → Add to Home Screen** (iPhone) or **⋮ → Install app** (Android). It then works like an app, even offline.
3. Tap **START** and allow the microphone.
4. Set your target tempo and play.

Tip: place the phone 1–2 m from the kit. If it misses hits or picks up too much, change **Mic sensitivity** in Settings.

## Privacy

Everything happens on your phone. Audio is never recorded, stored or sent anywhere. There are no accounts, no ads and no tracking.

## Built with

Plain HTML, CSS and JavaScript as a Progressive Web App (PWA), using the Web Audio API for hit detection. One codebase runs on iPhone and Android, with no app store needed.

---

<p align="center">Feedback welcome. Open an issue if something feels off.</p>
