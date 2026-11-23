"""VidGrab backend: FastAPI + yt-dlp.
Run:  pip install fastapi uvicorn yt-dlp   (ffmpeg must be installed)
      uvicorn server:app --host 0.0.0.0 --port 8000
Keep yt-dlp fresh:  pip install -U yt-dlp   (YouTube changes often)
"""
import asyncio, json, pathlib, re, tempfile, uuid
from concurrent.futures import ThreadPoolExecutor

import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from yt_dlp.utils import DownloadError

app = FastAPI(title="VidGrab")
TMP = pathlib.Path(tempfile.gettempdir()) / "vidgrab"
TMP.mkdir(exist_ok=True)
POOL = ThreadPoolExecutor(max_workers=4)
JOBS: dict[str, dict] = {}

PLATFORMS = {
    "youtube": re.compile(r"(youtube\.com|youtu\.be)/", re.I),
    "tiktok": re.compile(r"(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/", re.I),
}
ERRORS = [  # (substring in yt-dlp message, error code shown in UI)
    ("private", "private"),
    ("sign in", "login_required"),
    ("confirm your age", "age_restricted"),
    ("not available in your country", "geo_blocked"),
    ("blocked it in your country", "geo_blocked"),
    ("unavailable", "unavailable"),
    ("removed", "unavailable"),
    ("unsupported url", "unsupported"),
]


def detect(url: str) -> str | None:
    return next((n for n, rx in PLATFORMS.items() if rx.search(url)), None)


def map_error(e: Exception) -> str:
    msg = str(e).lower()
    return next((code for key, code in ERRORS if key in msg), "unknown")


class InfoReq(BaseModel):
    url: str


class JobReq(BaseModel):
    url: str
    quality: int = 1080          # max height: 360/720/1080/1440/2160
    format: str = "mp4"          # "mp4" | "mp3"


def _info(url: str) -> dict:
    with yt_dlp.YoutubeDL({"quiet": True, "noplaylist": True, "skip_download": True}) as y:
        d = y.extract_info(url, download=False)
    heights = sorted({f["height"] for f in d.get("formats", []) if f.get("height") and f.get("vcodec") != "none"})
    return {
        "platform": detect(url),
        "title": d.get("title"),
        "author": d.get("uploader") or d.get("channel"),
        "duration": d.get("duration"),
        "thumbnail": d.get("thumbnail"),
        "heights": heights,
    }


@app.post("/api/info")
async def info(req: InfoReq):
    if not detect(req.url):
        raise HTTPException(400, "unsupported")
    try:
        return await asyncio.get_event_loop().run_in_executor(POOL, _info, req.url)
    except DownloadError as e:
        raise HTTPException(422, map_error(e))


def _run(job_id: str, req: JobReq):
    job = JOBS[job_id]

    def hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            job.update(status="downloading", percent=round(d["downloaded_bytes"] / total * 100, 1) if total else 0,
                       speed=d.get("speed"), eta=d.get("eta"))
        elif d["status"] == "finished":
            job.update(status="processing", percent=100)

    h = req.quality
    opts = {
        "quiet": True, "noplaylist": True, "progress_hooks": [hook],
        "outtmpl": str(TMP / f"{job_id}.%(ext)s"),
        "concurrent_fragment_downloads": 8,   # speed: parallel fragments
        "retries": 5,
    }
    if req.format == "mp3":
        opts.update(format="bestaudio/best", postprocessors=[
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "320"}])
    else:
        # TikTok: yt-dlp's default best format is the no-watermark stream.
        opts.update(format=f"bv*[height<={h}][ext=mp4]+ba[ext=m4a]/bv*[height<={h}]+ba/b[height<={h}]/b",
                    merge_output_format="mp4")
    try:
        with yt_dlp.YoutubeDL(opts) as y:
            d = y.extract_info(req.url, download=True)
        f = next(TMP.glob(f"{job_id}.*"))
        job.update(status="done", percent=100, file=str(f), name=f"{d.get('title', 'video')}.{f.suffix[1:]}")
    except Exception as e:  # noqa: BLE001
        job.update(status="error", error=map_error(e))


@app.post("/api/jobs")
async def create_job(req: JobReq):
    if not detect(req.url):
        raise HTTPException(400, "unsupported")
    jid = uuid.uuid4().hex
    JOBS[jid] = {"status": "queued", "percent": 0}
    POOL.submit(_run, jid, req)
    return {"id": jid}


@app.get("/api/jobs/{jid}")
async def job_status(jid: str):
    if jid not in JOBS:
        raise HTTPException(404)
    return {k: v for k, v in JOBS[jid].items() if k != "file"}


@app.get("/api/jobs/{jid}/events")
async def events(jid: str):
    if jid not in JOBS:
        raise HTTPException(404)

    async def gen():
        while True:
            j = {k: v for k, v in JOBS[jid].items() if k != "file"}
            yield f"data: {json.dumps(j)}\n\n"
            if j["status"] in ("done", "error"):
                break
            await asyncio.sleep(0.5)
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/jobs/{jid}/file")
async def get_file(jid: str):
    j = JOBS.get(jid)
    if not j or j["status"] != "done":
        raise HTTPException(404)
    return FileResponse(j["file"], filename=j["name"])


@app.get("/")
async def index():
    return FileResponse(pathlib.Path(__file__).parent / "index.html")
