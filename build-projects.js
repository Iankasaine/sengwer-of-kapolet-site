#!/usr/bin/env node
/**
 * build-projects.js
 * ------------------------------------------------------------------
 * Pulls the Projects table from Airtable at BUILD TIME, downloads every
 * attached image into the site folder, resizes it, and writes projects.json.
 *
 * Why download the images instead of hot-linking Airtable?
 *   Airtable attachment URLs are signed and expire ~2 hours after you
 *   receive them. Linking them directly from the website guarantees
 *   broken images by the afternoon. We copy them into the site instead,
 *   so the published site has no runtime dependency on Airtable at all.
 *
 * Env vars required:
 *   AIRTABLE_TOKEN   - Airtable personal access token (scopes: data.records:read)
 *   AIRTABLE_BASE_ID - looks like appXXXXXXXXXXXXXX
 *   AIRTABLE_TABLE   - optional, defaults to "Projects"
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE = process.env.AIRTABLE_TABLE || 'Projects';

// Where the finished site lives. Everything below is relative to this file.
const SITE_DIR = __dirname;
const IMG_DIR = path.join(SITE_DIR, 'images', 'projects');
const JSON_OUT = path.join(SITE_DIR, 'projects.json');

const FULL_WIDTH = 1400; // lightbox / large view
const THUMB_WIDTH = 700; // card view
const QUALITY = 78;

function log(...a) { console.log('[projects]', ...a); }

function requireEnv() {
  const missing = [];
  if (!TOKEN) missing.push('AIRTABLE_TOKEN');
  if (!BASE_ID) missing.push('AIRTABLE_BASE_ID');
  if (missing.length) {
    console.error('\nMissing environment variable(s): ' + missing.join(', '));
    console.error('Set them in Netlify under Site settings > Environment variables,');
    console.error('or locally in a .env file. See SETUP-GUIDE.md step 4.\n');
    process.exit(1);
  }
}

/* ---------------- Airtable fetch (handles pagination) ---------------- */

async function fetchAllRecords() {
  const records = [];
  let offset;

  do {
    const url = new URL(
      `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`
    );
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable responded ${res.status}: ${body}`);
    }

    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);

  return records;
}

/* ---------------- image handling ---------------- */

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'project';
}

async function processImage(att, slug, index) {
  // Airtable attachment ids are stable across edits, so reusing them as the
  // filename means unchanged photos keep the same URL between builds.
  const base = `${slug}-${index + 1}-${att.id.slice(-6)}`;
  const fullName = `${base}.jpg`;
  const thumbName = `${base}-thumb.jpg`;
  const fullPath = path.join(IMG_DIR, fullName);
  const thumbPath = path.join(IMG_DIR, thumbName);

  // Skip the download if we already produced this exact file in a prior build.
  if (fs.existsSync(fullPath) && fs.existsSync(thumbPath)) {
    log(`  cached  ${fullName}`);
    const meta = await sharp(fullPath).metadata();
    return {
      full: `images/projects/${fullName}`,
      thumb: `images/projects/${thumbName}`,
      width: meta.width,
      height: meta.height
    };
  }

  const res = await fetch(att.url); // valid for ~2h from the API call above
  if (!res.ok) throw new Error(`Could not download image: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const img = sharp(buf).rotate(); // honour EXIF orientation from phone photos

  await img
    .clone()
    .resize({ width: FULL_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true })
    .toFile(fullPath);

  await img
    .clone()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true })
    .toFile(thumbPath);

  const meta = await sharp(fullPath).metadata();
  log(`  saved   ${fullName}`);

  return {
    full: `images/projects/${fullName}`,
    thumb: `images/projects/${thumbName}`,
    width: meta.width,
    height: meta.height
  };
}

/* ---------------- main ---------------- */

async function main() {
  requireEnv();
  fs.mkdirSync(IMG_DIR, { recursive: true });

  log(`Fetching "${TABLE}" from base ${BASE_ID}...`);
  const records = await fetchAllRecords();
  log(`${records.length} record(s) returned.`);

  const projects = [];
  const keptFiles = new Set();

  for (const rec of records) {
    const f = rec.fields;

    // Unchecked "Published" means the client is still drafting it. Skip.
    if (f.Published !== true) continue;

    const title = (f.Name || '').trim();
    if (!title) {
      log(`  ! skipping record ${rec.id} - no Title`);
      continue;
    }

    const slug = slugify(title);
    const attachments = Array.isArray(f.Images) ? f.Images : [];
    const images = [];

    log(`- ${title} (${attachments.length} image(s))`);

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      if (!att.type || !att.type.startsWith('image/')) {
        log(`  ! skipping non-image attachment "${att.filename}"`);
        continue;
      }
      try {
        const out = await processImage(att, slug, i);
        images.push({ ...out, alt: title });
        keptFiles.add(path.basename(out.full));
        keptFiles.add(path.basename(out.thumb));
      } catch (err) {
        log(`  ! image failed (${att.filename}): ${err.message}`);
      }
    }

    projects.push({
      id: rec.id,
      title,
      description: (f.Description || '').trim(),
      status: f.Status === 'Completed' ? 'Completed' : 'Ongoing',
      category: f.Category || null,
      link: f.Link || null,
      date: f.Date || null,
      order: typeof f.Order === 'number' ? f.Order : null,
      images
    });
  }

  // Manual Order first, then newest date, then title.
  projects.sort((a, b) => {
    if (a.order !== null && b.order !== null) return a.order - b.order;
    if (a.order !== null) return -1;
    if (b.order !== null) return 1;
    if (a.date && b.date) return b.date.localeCompare(a.date);
    return a.title.localeCompare(b.title);
  });

  // Remove images belonging to projects that were deleted or unpublished.
  let removed = 0;
  for (const file of fs.readdirSync(IMG_DIR)) {
    if (!keptFiles.has(file)) {
      fs.unlinkSync(path.join(IMG_DIR, file));
      removed++;
    }
  }
  if (removed) log(`Cleaned up ${removed} unused image file(s).`);

  fs.writeFileSync(
    JSON_OUT,
    JSON.stringify({ generatedAt: new Date().toISOString(), projects }, null, 2)
  );

  log(`Wrote ${projects.length} project(s) to projects.json. Done.`);
}

main().catch(err => {
  console.error('\n[projects] BUILD FAILED:', err.message);
  process.exit(1);
});
