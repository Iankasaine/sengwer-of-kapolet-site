# Projects Backend — Setup Guide (Developer)

**Stack:** Airtable (client-facing editor) → Netlify build step → static `projects.json` + local images → site renders.

The client edits an Airtable base. A build script pulls the records, **downloads the photos into the site**, and writes `projects.json`. The published site never talks to Airtable.

---

## Why this design

The obvious approach — fetch Airtable from the browser — fails twice:

1. **The token would be public.** Anything in frontend JS is readable by anyone. An Airtable token grants write and delete access to the base.
2. **The images would break.** Airtable attachment URLs are signed and expire roughly two hours after you receive them. Any image URL saved into a page stops working the same afternoon.

Fetching at build time fixes both. The token stays in a Netlify environment variable, and the photos become ordinary files in the site.

You said a few minutes' delay is fine, which is exactly what makes this available.

---

## Step 1 — Create the Airtable base

Create a base called **Sengwer of Kapolet**, and a table called **Projects**. Delete Airtable's sample fields and create these, with the names spelled exactly as shown (the script matches on them):

| Field name | Type | Notes |
|---|---|---|
| `Name` | Single line text | The primary field. This is the project title. |
| `Description` | Long text | 1–3 sentences. |
| `Status` | Single select | Options exactly: `Ongoing`, `Completed` |
| `Images` | Attachment | Main image first; the rest become the small gallery. |
| `Category` | Single select | Optional. Suggest using the seven objective names. |
| `Link` | URL | Optional. |
| `Date` | Date | Optional. |
| `Published` | Checkbox | **Unchecked rows never appear on the site.** |
| `Order` | Number | Optional. Lower numbers appear first. |

Then delete the three empty starter rows and add one real project to test with.

> Keep the field names in English exactly as above even if you rename the *table* view labels. Renaming a field in Airtable silently breaks the build.

## Step 2 — Create a Personal Access Token

1. Go to <https://airtable.com/create/tokens>
2. **Create new token**, name it `sengwer-site-build`
3. Scope: `data.records:read` **only** — do not add write scopes
4. Access: add just the *Sengwer of Kapolet* base
5. Copy the token now; Airtable shows it once

Also copy the **Base ID** from <https://airtable.com/api> (or the URL — it starts with `app`).

## Step 3 — Put the site files in a Git repo

Your repo root should contain:

```
index.html
projects.json          <- starter file, overwritten by each build
build-projects.js
package.json
netlify.toml
images/projects/       <- created automatically
```

Add a `.gitignore` containing `node_modules` and `.env`.

## Step 4 — Deploy on Netlify

1. Netlify → **Add new site → Import an existing project** → pick the repo
2. Build command `npm run build`, publish directory `.` (already set in `netlify.toml`)
3. **Site settings → Environment variables**, add:
   - `AIRTABLE_TOKEN` = the token from step 2
   - `AIRTABLE_BASE_ID` = the `app...` id
   - `AIRTABLE_TABLE` = `Projects` (optional)
4. Deploy. Watch the log — you should see each project and image listed.

Netlify's free tier covers this comfortably (300 build minutes/month; a build here takes well under a minute).

## Step 5 — Make the client's edits publish themselves

So the client never touches Netlify:

1. Netlify → **Site settings → Build & deploy → Build hooks → Add build hook**. Name it `Airtable update`. Copy the URL.
2. In Airtable → **Automations → Create automation**
   - Trigger: **When record updated**, table `Projects`, watching all the fields above
   - Action: **Send webhook** (or "Run script" with a `fetch`), method `POST`, URL = the build hook
3. Add a second automation with trigger **When record created**, same action.
4. Test it: tick `Published` on a row, wait ~2 minutes, reload the site.

If the client is on Airtable's free plan, automation runs are capped per month. If you ever hit the cap, replace the automation with a **scheduled Netlify build** (Site settings → Build & deploy → Build hooks, plus a free cron service hitting the hook daily), or just give the client the Netlify "Trigger deploy" button.

## Step 6 — Local testing

```bash
npm install
AIRTABLE_TOKEN=xxx AIRTABLE_BASE_ID=appxxx npm run build
npx serve .        # must be served over http, not opened as a file://
```

Opening `index.html` directly from disk will not work — `fetch('projects.json')` is blocked on `file://`.

---

## How the frontend consumes it

`index.html` now has two empty containers, `#ongoing` and `#done`. On load it fetches `projects.json`, splits by `Status`, and renders cards using the existing `.proj-card` styling. Each card shows the main image, status pill, title, description, remaining photos as small thumbnails, then category / date / link. Clicking any image opens the existing lightbox.

If `projects.json` is missing or malformed, the section shows a short "being updated" line rather than breaking the page.

---

## Security notes

- **The token never reaches the browser.** It exists only in Netlify's environment variables and in build logs' absence. Confirm by searching the deployed `index.html` for `AIRTABLE` — there should be no match.
- **Scope the token to read-only and to one base.** If it leaks, the damage is limited to reading projects the client already publishes.
- **Rotate the token** if a developer leaves the project. Airtable → tokens → regenerate; update the Netlify variable; redeploy.
- **Anyone with Airtable edit access can change the live site.** Invite the client as an **Editor**, not an Owner, and keep ownership yourself so access can be revoked.
- `Published` is the safety valve — the client can draft freely without anything appearing publicly.

## Limitations to be aware of

- **Not instant.** Edits appear after a rebuild, typically 1–2 minutes.
- **Airtable free plan caps records and attachment storage per base.** For a projects list this is not a realistic ceiling, but very large photo libraries will eventually hit the attachment limit. Check Airtable's current plan limits if the client starts uploading hundreds of full-resolution photos.
- **Deleting a project in Airtable deletes it from the site** on the next build; there's no trash. Advise unticking `Published` instead.
- **Image filenames derive from the title and attachment id.** Renaming a project re-downloads its images on the next build. Harmless, just slightly slower.
- **The build fails loudly** if Airtable is unreachable or a field is renamed. Netlify keeps the previous deploy live when a build fails, so the site does not go down — but the client's edit silently won't appear. Turn on Netlify's build-failure email notifications.
- **One table only.** If you later want news or events managed the same way, duplicate the script with a different table name and output file.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Build fails, `401` | Token wrong, expired, or lacks access to the base |
| Build fails, `403` | Token missing the `data.records:read` scope |
| Build fails, `404` | Base ID wrong, or table isn't named `Projects` |
| Project missing from site | `Published` unchecked, or `Name` empty |
| Images missing, everything else fine | Attachment wasn't an image file, or upload was still processing at build time — rebuild |
| Edits never appear | Airtable automation not firing; check its run history |
