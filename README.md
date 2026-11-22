# Yamtrack for LG webOS

Homebrew client for LG webOS, originally developed for the OLED65CXPUA running webOS 5.6.2.

The TV opens a LAN helper that proxies the existing Yamtrack interface. Sign in on your **phone**, approve the TV, and then use the remote to browse lists, search, and activate Yamtrack's episode watched controls. The helper preserves Yamtrack's CSRF checks and uses its existing session authentication. It does not use the public Cloudflare/GitHub login.

## 1. Deploy the helper beside Yamtrack

Run this on your Docker Compose host. Copy this project directory there first, including `helper/`, `Dockerfile`, `requirements.txt`, and `compose.yaml`. The Compose project is separate from your existing Yamtrack stack.

If using the deployment bundle, extract it first:

```sh
tar -xzf yamtrack-tv-0.1.17.tgz
```

Create a `.env` file beside `compose.yaml`. Replace the example hostnames with the hostnames or IP addresses for your LAN:

```dotenv
YAMTRACK_URL=http://yamtrack.example:8000
TV_PUBLIC_URL=http://tv-helper.example:8765
```

`YAMTRACK_URL` is the address the helper uses to reach Yamtrack. `TV_PUBLIC_URL` is the exact address your TV and phone use to reach the helper. Use origins with an optional port and no path.

```sh
cd /path/to/WebOS_Yamtrack
docker compose -p yamtrack-tv up -d --build
docker compose -p yamtrack-tv logs --tail=50
```

The helper uses the following paths and defaults. [Compose configuration](compose.yaml)

| Setting | Value |
| --- | --- |
| Helper port | `8765` |
| Pairing page displayed by the TV | `TV_PUBLIC_URL` followed by `/__tv/` |
| Address to open on your phone | `TV_PUBLIC_URL` followed by `/__tv/pair` |
| Persistent sessions | `./data/sessions.json` on the Compose host |
| Waitress worker threads | `8` |

From a phone on your home Wi-Fi, open `/__tv/pair` at `TV_PUBLIC_URL`. Seeing a code-entry form confirms the helper is reachable. If necessary, allow TCP port **8765** from your LAN in the host's firewall. The helper container also needs to reach `YAMTRACK_URL`.

The helper is intended for your trusted LAN. It handles authenticated sessions over the existing local HTTP connection; keep port 8765 off the public internet. `data/sessions.json` contains session secrets, is created with mode `0600`, and should stay out of source control. Passwords are forwarded only during the normal phone login and are not saved. Compose logs include Waitress diagnostics and Common Log Format access entries with full URLs, including query strings. URLs can contain calendar tokens or pairing codes.

If a container on your host cannot reach the host's LAN IP, join the helper to Yamtrack's Docker network and set `YAMTRACK_URL` to its Compose service address, for example `http://yamtrack:8000`. Keep `TV_PUBLIC_URL` at the LAN address that phones and the TV use. The upstream hostname must already be allowed by Yamtrack's Django `ALLOWED_HOSTS` setting.

## 2. Install the homebrew app on the TV

The container installs Flask and Waitress into its Python environment and reads existing pairings from `data/sessions.json`.

Version **0.1.15** keeps the current page visible while loading Calendar, libraries, Lists, and other TV views. It also fixes the positioning of cast portraits. Existing installations receive these updates after rebuilding the helper and reopening the app.

Version **0.1.2** adds a locally generated QR code with the pairing code prefilled on the phone, and uses the official Yamtrack icon. Rebuild the helper for the QR screen and install the new IPK for the launcher icon.

Version **0.1.1** fixes the epoch-zero archive timestamps in the original 0.1.0 package, which can cause `ipk verified failed` on webOS 5.x. Install 0.1.1 instead of retrying 0.1.0. The helper container does not need updating for this packaging fix.

Running `python3 scripts/build.py` locally creates `dist/github.sshah7433.webos.yamtrack_0.1.17_all.ipk`. Its app ID is **`github.sshah7433.webos.yamtrack`**, and its display name is **Yamtrack**. You do not need an LG developer account or an Apple developer account for this rooted-TV installation.

If you previously installed Yamtrack as `org.local.yamtrack.tv`, webOS installs the new IPK as a separate app. Enter your helper address and pair the new app, then remove the old copy through Glasshouse or Dev Manager.

### Using your existing Glasshouse installation

1. Open your TV's Glasshouse dashboard from a computer browser using the TV's LAN address.
2. Open **Apps**, then **Install app from a URL or file**. If this section is disabled, turn it on using its own switch and review Glasshouse's prompt.
3. Choose **Upload .ipk** and select `dist/github.sshah7433.webos.yamtrack_0.1.17_all.ipk` from this project.
4. Review the installation preview and install it.
5. Find **Yamtrack** in the installed apps list and choose **Launch**. It is also a normal installed webOS app that a launcher can open by app ID.

The Upload option depends on your installed Glasshouse version. If it is absent, use webOS Dev Manager below. No Glasshouse launcher modifications are required.

### Alternative: webOS Dev Manager

1. Download [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop/releases).
2. Ensure your rooted TV's SSH service is enabled in Homebrew Channel.
3. Add or select your TV in Dev Manager using your existing rooted-TV SSH connection: the TV's LAN IP, typically port **22**, user **root**, and your configured password or SSH key. The Developer Mode `prisoner`/9922 connection is a different setup.
4. Open its apps view, choose **Install**, and select the `.ipk` above.
5. Launch **Yamtrack**.

### Alternative: webOS CLI

On your computer, install LG's current CLI and register the TV:

```sh
npm install -g @webos-tools/cli
ares-setup-device
```

In the interactive device setup, add a device named `lgtv` using the **TV's IP**, your rooted-TV SSH port (normally `22`), user `root`, and your existing SSH authentication. Then, from this project directory:

```sh
ares-install -d lgtv dist/github.sshah7433.webos.yamtrack_0.1.17_all.ipk
ares-launch -d lgtv github.sshah7433.webos.yamtrack
```

## 3. Pair from your phone

1. Launch **Yamtrack**, enter the exact URL from `TV_PUBLIC_URL`, and choose **Connect**. Later launches open the saved address automatically. An unpaired TV displays a six-digit code valid for ten minutes.
2. Scan the TV’s QR code using your phone camera. It opens the phone pairing form with the code already filled in.
3. Choose **Continue to Yamtrack login**. Alternatively, open `/__tv/pair` at `TV_PUBLIC_URL` and enter the displayed code on your phone.
4. Sign into Yamtrack on the phone using your normal app login. If Yamtrack offers **Remember me**, select it for a longer session.
5. Choose **Approve TV** on the phone. The TV should open your Yamtrack home page within a few seconds.

There is no password entry on the TV. The helper stores the approved phone login's Yamtrack session, associated with a random TV device cookie. The underlying Yamtrack session still expires according to your server's settings; pair again when it expires. Logging out of that shared session also disconnects the TV. The helper expects Django's default `sessionid` cookie and a login-protected homepage, as in your described installation.

After helper/container restarts, the `./data` bind mount preserves the approved session. Losing the TV app's cookies, reinstalling the app, or deleting that data may require pairing again.

## 4. Use the remote

| Control | Action |
| --- | --- |
| Arrow keys | Move the blue focus outline between controls |
| OK | Activate the focused link, button, checkbox, or episode action |
| OK on a search field | Open the app's remote-controlled keyboard |
| Keyboard **Search** | Submit the existing Yamtrack search form |
| Back | Close the TV keyboard/help or return to the previous page |
| Back on Home | Exit the app |
| Red | Home |
| Green | Lists |
| Yellow | Search |
| Blue | Help |
| Magic Remote pointer | Move the remote to show the cursor, press OK to click, and use the wheel to scroll |

Use **Search** in the top toolbar or press **Yellow** to open the TV keyboard. Choose a media type above the keys when multiple types are available. Use **Lists** to browse your personal lists. On Home, use **+** or **−** to change progress. For a specific episode, open the show and season, move focus to Yamtrack's watched control, and press OK once. Requests go through Yamtrack's own forms and HTMX handlers. After the control refreshes, the app attempts to restore nearby focus.

These color-key shortcuts apply while the Yamtrack app is running. Any Glasshouse/system-level remote remapping may take priority.

## Build and publish releases

GitHub Actions tests the helper, smoke-tests the Docker image, and builds the webOS IPK, SHA-256 checksum, and deployment bundle for every branch push and pull request. Find those files in the `yamtrack-webos-<version>` artifact for the run.

Push a `vX.Y.Z` tag, such as `v0.1.18`, on the commit you want to release. The workflow uses the tag version for the packaged app manifest and release artifacts. Local and untagged builds use the version in `app/appinfo.json`. The workflow publishes the smoke-tested helper images for Linux amd64, arm64, and arm/v7 under a single version tag at `ghcr.io/sshah7433/webos_yamtrack`. It also attaches the webOS files and platform-specific Docker archives with checksums to the GitHub Release.

To deploy from GitHub Container Registry, replace `0.1.18` with a published version. Docker selects the image for your host. A new GHCR package is private by default and requires login to pull. Set the package visibility to public if you want anonymous pulls. [GitHub package visibility settings](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

```sh
YAMTRACK_TV_IMAGE=ghcr.io/sshah7433/webos_yamtrack:0.1.18 docker compose -p yamtrack-tv up -d --no-build --pull always
```

For offline deployment, download the helper archive for your Docker host from the release. On a Raspberry Pi 5, use `linux-arm64` for 64-bit Raspberry Pi OS or `linux-armv7` for 32-bit. Use `linux-amd64` on an Intel or AMD PC. On the Docker host, run the commands below with the filename for your platform. [Docker image loading](https://docs.docker.com/reference/cli/docker/image/load/)

```sh
docker image load -i yamtrack-helper-0.1.17-linux-arm64.tar.gz
YAMTRACK_TV_IMAGE=yamtrack-helper:0.1.17 docker compose -p yamtrack-tv up -d --no-build --pull never
```

## Updating, removing, and troubleshooting

To update the helper after changing its source:

```sh
docker compose -p yamtrack-tv up -d --build
```

Remote controls and CSS compatibility code live in the helper. Rebuild and reinstall the IPK when changing the launcher or the app manifest:

```sh
python3 scripts/build.py
```

The dependency-free packager produces a standard unsigned webOS IPK. To package with LG's official tooling instead:

```sh
ares-package --no-minify --outdir dist app
```

If either server address changes, update the matching setting in `.env` and recreate the helper. When the saved helper is unreachable, the app opens the connection screen with the old address filled in. Enter the new `TV_PUBLIC_URL` and choose **Connect**. Pair again if the new origin has no saved pairing.

If installation still reports `ipk verified failed` with **0.1.1**, check the TV’s date/time and time zone. An incorrect TV clock has also caused this error on CX sets. Correct the clock and retry; if it persists, retain the full install log for diagnosis. See the [timestamp-related fix in another webOS 5.x app](https://github.com/danielthejoker18/FreeMyTvWebOS/releases/tag/v1.2.4) and the [CX clock-related report](https://github.com/throwaway96/slopbro/issues/87).

If the app is blank or cannot connect, open `/__tv/` at `TV_PUBLIC_URL` in the TV browser. Check the Compose logs and firewall. If pairing works but login fails, verify the normal Yamtrack login at `YAMTRACK_URL` and check that the helper container can reach it. A custom session-cookie name, a cookie explicitly marked Secure on an HTTP deployment, or proxy settings that force a public hostname need configuration adjustments.

If paired pages look wrong, inspect the app with `ares-inspect -d lgtv --app github.sshah7433.webos.yamtrack` and compare your deployed Yamtrack version. webOS 5.x uses Chromium 68; the helper lowers Tailwind layers, common nesting, colors, spacing, and media queries, but is not a complete modern-browser replacement. Yamtrack's own JavaScript and any future frontend changes may need additional compatibility work.

Yamtrack's upstream stylesheet uses a platform font stack. The TV helper serves static WOFF faces derived from upstream's bundled Roboto Flex so the app, pairing screens, and statistics charts load the same font from the LAN. The launcher bootstrap screen, monospace text, and glyphs outside the bundled faces use device fonts. [LG web font guidance](https://webostv.developer.lge.com/develop/getting-started/app-resources)

The TV helper serves a Chromium 68 build of Yamtrack's Chart.js 4.4.9 bundle. To regenerate it from a Yamtrack checkout, run the following from this repository with the path to Yamtrack's original bundle.

```sh
npx --yes esbuild@0.28.2 /path/to/Yamtrack/src/static/js/libraries/chartjs-4.4.9.min.js \
  --target=chrome68 --minify-whitespace --legal-comments=inline \
  --outfile=helper/static/vendor/chartjs-4.4.9.chrome68.min.js
```

Waitress logs `Task queue depth` when incoming requests outnumber free workers. A single page can send several parallel asset requests, and each proxied request holds a worker while waiting on Yamtrack. The helper starts with eight workers. If warnings persist, check response times on the upstream Yamtrack server and set `TV_THREADS` in Compose’s environment if the host has room for more concurrent requests. Recreate the helper to apply the setting. [Waitress worker configuration](https://docs.pylonsproject.org/projects/waitress/en/stable/arguments.html#threads)

To remove the app through the CLI:

```sh
ares-install -d lgtv --remove github.sshah7433.webos.yamtrack
```

Or uninstall it through Glasshouse/Dev Manager. Stop the helper with `docker compose -p yamtrack-tv down`. To revoke all helper pairings, stop it, delete `data/sessions.json`, and start it again; also invalidate the corresponding Yamtrack session if you need to revoke it at the source.

## Validation and limits

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
node --check helper/static/client.js
node --check helper/static/pair.js
node --test tests/test_*.js
python3 scripts/build.py
```

Automated checks cover pairing, required approval, expiration, authenticated episode POST forwarding, CSRF origin handling, session-file permissions, focused CSS lowering, and package timestamps in every archive layer. The Flask test client exercises the helper with a simulated upstream. JavaScript syntax is checked locally. Docker deployment and verification on the physical CX require access to the LAN environment.

References: [webOS Homebrew development](https://www.webosbrew.org/develop/), [webOS app installation workflow](https://www.webosbrew.org/develop/guides/workflow/), [LG web engine versions](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine), [Yamtrack](https://github.com/FuzzyGrim/Yamtrack). The Glasshouse upload workflow is documented in its `docs/dashboard/apps.md`.

## Third-party assets

The official Yamtrack icon comes from `FuzzyGrim/Yamtrack`, `src/static/favicon/android-chrome-512x512.png`. The original, source revision notice, and AGPL license are included under `app/assets/`; the launcher sizes are resized copies. The offline QR encoder is adapted from Glasshouse’s MIT-licensed `server/assets/qr.js`, with its license and attribution retained in `helper/static/qr.js`. The QR code is drawn in the TV browser and is hidden when the pairing code expires. Long custom helper URLs that exceed the encoder’s capacity retain the manual address/code fallback.

The derived font faces are packaged with their [source notice](helper/static/fonts/NOTICE.txt) and [SIL Open Font License](helper/static/fonts/OFL.txt).
