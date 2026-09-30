# Encore

Re-rank a YouTube playlist by views, likes, comments, like rate, length or upload date, and save the result as a new playlist.

Encore is a small local Mac app: a zero-dependency Node server plus a dark web UI that runs as a Chrome PWA. You sign in to YouTube once; it keeps a refresh token on your Mac and renews access by itself.

![Encore icon](icon/icon-1024.png)

## Features

- Sort any of your playlists (or any playlist link) by views, likes, comments, like rate, length, upload date, title or original order
- See how far each video moved (▲/▼) and keep only the top N
- Builds the new playlist in the background — closing or reloading the window doesn't interrupt it
- Live countdown of time left, and of when YouTube's daily quota resets
- Stops cleanly at the daily quota and resumes where it left off
- Deleted/private videos are skipped automatically

## Requirements

- macOS, Node.js 18+ (`brew install node`), Google Chrome
- A Google Cloud OAuth client of your own (free, ~5 minutes)

## Install

```bash
git clone https://github.com/yatharth1011/encore.git
cd encore
./install.sh
```

This copies the server and UI to `~/Library/Application Support/Encore` and creates `~/Applications/Encore.app`. Open Encore; the first screen walks you through setup.

For a dedicated window with its own Dock icon, install it as an app from Chrome (⋮ → **Install Encore**). The launcher then opens that window every time.

## Google setup (one time)

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/projectcreate).
2. Enable the [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
3. In **Google Auth Platform**, configure the consent screen (External), then on **Audience** click **Publish app**. In "Testing" mode Google signs you out every 7 days.
4. Under **Clients**, create an OAuth client of type **Desktop app** and download its JSON.
5. Paste that JSON into Encore and click **Connect YouTube account**. On "Google hasn't verified this app", choose **Advanced → Go to … (unsafe)** — it's your own app.

Your client secret and tokens stay on your Mac (`~/Library/Application Support/Encore`) and are never part of this repository.

## Quota

YouTube's API allows 10,000 units per day per project, reset at midnight Pacific time. Adding one video costs 50 units, so roughly 190 videos fit per day. Larger playlists pause at the limit; click **Resume** after the reset.

Encore can hold up to three OAuth clients and move to the next when one runs out of quota. Note that using multiple projects to exceed quota is against the [YouTube API Services Terms](https://developers.google.com/youtube/terms/developer-policies) — the supported route is to [request a quota extension](https://support.google.com/youtube/contact/yt_api_form).

## Development

```bash
node server.js   # serves http://127.0.0.1:8812
```

Re-run `./install.sh` after changes; it restarts a running server on the new code.
