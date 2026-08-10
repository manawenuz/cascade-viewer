import express from "express";
import { readFileSync, existsSync, readdirSync, mkdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);
const thumbInProgress = new Map();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3102;
const DOWNLOADS_BASE = process.env.MEDIA_BASE || process.env.OF_BASE || (process.env.HOME ? join(process.env.HOME, "Downloads", "OF") : "/data");
const THUMBS_BASE = process.env.THUMBS_BASE || process.env.OF_THUMBS || join(DOWNLOADS_BASE, ".viewer-thumbs");

// ── In-memory metadata cache ──────────────────────────────
const metaCache = new Map(); // creator → { data, mtime }

function getMetadata(creator) {
  const file = join(DOWNLOADS_BASE, `${creator}-of`, "metadata.json");
  if (!existsSync(file)) return null;
  const mtime = String(statSync(file).mtimeMs);
  const cached = metaCache.get(creator);
  if (cached && cached.mtime === mtime) return cached.data;
  const data = JSON.parse(readFileSync(file, "utf8"));
  metaCache.set(creator, { data, mtime });
  return data;
}

// ── Background thumb pre-generation ──────────────────────
const THUMB_CONCURRENCY = 2;
let thumbQueue = [];
let thumbWorkers = 0;

async function generateThumb(videoFile, thumbFile) {
  await execFileP("ffmpeg", [
    "-ss", "5", "-i", videoFile,
    "-frames:v", "1", "-q:v", "3", "-vf", "scale=480:-1", "-y", thumbFile,
  ]).catch(() =>
    execFileP("ffmpeg", [
      "-i", videoFile,
      "-frames:v", "1", "-q:v", "3", "-vf", "scale=480:-1", "-y", thumbFile,
    ]).catch(() => null)
  );
}

function drainThumbQueue() {
  while (thumbWorkers < THUMB_CONCURRENCY && thumbQueue.length > 0) {
    const { videoFile, thumbFile, resolve } = thumbQueue.shift();
    thumbWorkers++;
    generateThumb(videoFile, thumbFile).then(() => {
      thumbWorkers--;
      resolve();
      drainThumbQueue();
    });
  }
}

function queueThumb(videoFile, thumbFile) {
  return new Promise((resolve) => {
    thumbQueue.push({ videoFile, thumbFile, resolve });
    drainThumbQueue();
  });
}

function preGenThumbs(creator) {
  const timelineDir = resolve(DOWNLOADS_BASE, `${creator}-of`, "Timeline");
  const thumbDir = resolve(THUMBS_BASE, creator);
  if (!existsSync(timelineDir)) return;
  mkdirSync(thumbDir, { recursive: true });
  const videos = readdirSync(timelineDir).filter(f => f.endsWith(".mp4"));
  let queued = 0;
  for (const v of videos) {
    const thumbFile = join(thumbDir, v + ".jpg");
    if (existsSync(thumbFile)) continue;
    const videoFile = join(timelineDir, v);
    thumbQueue.push({ videoFile, thumbFile, resolve: () => {} });
    queued++;
  }
  if (queued > 0) {
    console.log(`[thumbs] queued ${queued} videos for ${creator}`);
    drainThumbQueue();
  }
}

// Pre-gen thumbs for all creators at startup
function startupPreGen() {
  try {
    const creators = readdirSync(DOWNLOADS_BASE, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.endsWith("-of"))
      .map(d => d.name.replace(/-of$/, ""));
    for (const c of creators) preGenThumbs(c);
  } catch {}
}

// ── Static ────────────────────────────────────────────────
app.use("/public", express.static(join(__dirname, "public")));

// ── Media files ───────────────────────────────────────────
app.get("/media/:creator/*", (req, res) => {
  const relPath = req.params[0];
  const creatorDir = resolve(DOWNLOADS_BASE, `${req.params.creator}-of`);
  const candidates = [
    resolve(creatorDir, relPath),
    resolve(creatorDir, "Timeline", relPath),
    resolve(creatorDir, "Messages", relPath),
    resolve(creatorDir, "Stories", relPath),
  ];
  for (const file of candidates) {
    if (existsSync(file) && statSync(file).isFile()) {
      return res.sendFile(file);
    }
  }
  res.status(404).send("Not found");
});

// ── Thumbnails ────────────────────────────────────────────
app.get("/thumb/:creator/*", async (req, res) => {
  const relPath = req.params[0];
  const creatorDir = resolve(DOWNLOADS_BASE, `${req.params.creator}-of`);
  const candidates = [
    resolve(creatorDir, relPath),
    resolve(creatorDir, "Timeline", relPath),
    resolve(creatorDir, "Messages", relPath),
    resolve(creatorDir, "Stories", relPath),
  ];
  const videoFile = candidates.find(f => existsSync(f) && statSync(f).isFile());
  if (!videoFile) return res.status(404).send("Not found");

  const thumbDir = resolve(THUMBS_BASE, req.params.creator);
  mkdirSync(thumbDir, { recursive: true });
  const thumbFile = join(thumbDir, relPath.replace(/\//g, "_") + ".jpg");

  if (existsSync(thumbFile)) return res.sendFile(thumbFile);

  // Dedupe concurrent requests for the same thumb
  if (thumbInProgress.has(thumbFile)) {
    await thumbInProgress.get(thumbFile);
    return existsSync(thumbFile) ? res.sendFile(thumbFile) : res.status(500).send("Failed");
  }

  const p = queueThumb(videoFile, thumbFile);
  thumbInProgress.set(thumbFile, p);
  await p;
  thumbInProgress.delete(thumbFile);

  return existsSync(thumbFile) ? res.sendFile(thumbFile) : res.status(500).send("Failed");
});

// ── API ───────────────────────────────────────────────────
app.get("/api/creators", (_req, res) => {
  try {
    const dirs = readdirSync(DOWNLOADS_BASE, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.endsWith("-of"))
      .map(d => d.name.replace(/-of$/, ""))
      .filter(name => existsSync(join(DOWNLOADS_BASE, `${name}-of`, "metadata.json")));
    res.json(dirs);
  } catch { res.json([]); }
});

app.get("/api/metadata/:creator", (req, res) => {
  const data = getMetadata(req.params.creator);
  if (!data) return res.status(404).json({ error: "No metadata found." });
  res.json(data);
});

app.get("*", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Cascade Viewer → http://localhost:${PORT}`);
  startupPreGen();
});
