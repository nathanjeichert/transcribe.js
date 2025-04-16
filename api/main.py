"""
main.py  –  FastAPI back‑end for Gemini Transcriber
Includes full Cloudflare R2 logic *and* the complete safety‑settings array.
"""

import os, io, time, json, tempfile, traceback
from typing import List, Optional

import boto3
from botocore.client import Config
from fastapi import (
    FastAPI,
    File,
    UploadFile,
    Form,
    Query,
    HTTPException,
    Depends,
)
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError

from google import genai
from google.genai import types
from google.api_core import exceptions as gex

from docx import Document
from docx.shared import Inches, Pt

# ────────────────────  CONFIG  ────────────────────
API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = "gemini-2.5-pro-exp-03-25"

R2_ENDPOINT = os.getenv("R2_ENDPOINT")
R2_ID = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET = os.getenv("R2_SECRET_ACCESS_KEY")
R2_BUCKET = os.getenv("R2_BUCKET_NAME", "transcript")

# ────────────────────  HELPERS  ────────────────────
def r2():
    if not all([R2_ENDPOINT, R2_ID, R2_SECRET]):
        return None
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ID,
        aws_secret_access_key=R2_SECRET,
        config=Config(signature_version="s3v4"),
    )

def gem():
    return genai.Client(api_key=API_KEY) if API_KEY else None

r2_client = r2()

def mime(ext: str):
    return {
        "mp3": "audio/mp3",
        "wav": "audio/wav",
        "aiff": "audio/aiff",
        "aac": "audio/aac",
        "ogg": "audio/ogg",
        "flac": "audio/flac",
    }.get(ext.lower())

def upload_r2(data: bytes, fn: str, ct: str) -> str:
    if not r2_client:
        raise HTTPException(503, "R2 unavailable")
    key = f"{int(time.time())}_{fn}"
    r2_client.put_object(Bucket=R2_BUCKET, Key=key, Body=data, ContentType=ct)
    return key

async def delete_r2(key: str):
    if r2_client:
        try:
            r2_client.delete_object(Bucket=R2_BUCKET, Key=key)
        except Exception:
            pass

async def delete_gem(name: str, client: genai.Client):
    if client:
        try:
            client.files.delete(name=name)
        except Exception:
            pass

def replace_text(el, ph, val):
    if hasattr(el, "paragraphs"):
        for p in el.paragraphs:
            replace_text(p, ph, val)
    if hasattr(el, "runs") and ph in el.text:
        for r in el.runs:
            r.text = r.text.replace(ph, val)
    if hasattr(el, "tables"):
        for t in el.tables:
            for row in t.rows:
                for cell in row.cells:
                    replace_text(cell, ph, val)

def make_docx(titles: dict, turns: List["TranscriptTurn"]):
    tmpl = "api/transcript_template.docx"
    if not os.path.exists(tmpl):
        raise HTTPException(500, "template missing")
    doc = Document(tmpl)
    for k, v in titles.items():
        replace_text(doc, f"{{{{{k}}}}}", str(v or ""))
    body_ph = "{{TRANSCRIPT_BODY}}"
    ph_para = next((p for p in doc.paragraphs if body_ph in p.text), None)
    if ph_para:
        ph_para._element.getparent().remove(ph_para._element)
    for trn in turns:
        p = doc.add_paragraph()
        p.paragraph_format.first_line_indent = Inches(1)
        p.paragraph_format.line_spacing = 2
        p.add_run(f"{trn.speaker.upper()}:   ").font.name = "Courier New"
        p.add_run(trn.text).font.name = "Courier New"
    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf

# ────────────────────  MODELS  ────────────────────
class TranscriptTurn(BaseModel):
    speaker: str
    text: str

class ReqData(BaseModel):
    case_name: Optional[str] = None
    case_number: Optional[str] = None
    firm_name: Optional[str] = None
    input_date: Optional[str] = None
    input_time: Optional[str] = None
    location: Optional[str] = None
    speaker_names: Optional[List[str]] = None

class DocxReq(BaseModel):
    gemini_file_name: str
    title_data: dict
    transcript_turns: List[TranscriptTurn]

# ────────────────────  APP  ────────────────────
app = FastAPI(title="Gemini Transcriber API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ────────────────────  ENDPOINTS  ────────────────────
@app.get("/generate_r2_presigned")
def presign(filename: str = Query(...), content_type: str = Query(...)):
    if not r2_client:
        raise HTTPException(503, "R2 unavailable")
    key = f"{int(time.time())}_{filename}"
    url = r2_client.generate_presigned_url(
        "put_object",
        Params={"Bucket": R2_BUCKET, "Key": key, "ContentType": content_type},
        ExpiresIn=3600,
    )
    return {"upload_url": url, "object_key": key}

@app.post("/transcribe")
async def transcribe(
    request_data_json: str = Form(...),
    audio_file: UploadFile | None = File(None),
    r2_object_key: Optional[str] = Form(None),
    g: genai.Client = Depends(gem),
):
    if not g:
        raise HTTPException(503, "Gemini unavailable")
    if not (audio_file or r2_object_key):
        raise HTTPException(400, "audio_file OR r2_object_key required")

    # ---------- bytes ----------
    if r2_object_key:
        s3obj = r2_client.get_object(Bucket=R2_BUCKET, Key=r2_object_key)
        data = s3obj["Body"].read()
        ext = r2_object_key.split(".")[-1]
    else:
        data = await audio_file.read()
        ext = audio_file.filename.split(".")[-1]
        r2_object_key = upload_r2(data, audio_file.filename, audio_file.content_type)

    mt = mime(ext)
    if not mt:
        raise HTTPException(400, f"unsupported {ext}")

    with tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}") as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        f = g.files.upload(file=tmp_path)
        for _ in range(12):
            if g.files.get(name=f.name).state.name == "ACTIVE":
                break
            time.sleep(5)

        req = ReqData.parse_raw(request_data_json)
        prompt = (
            "Generate a transcript of the speech. "
            + (
                f"The speakers are: {', '.join(req.speaker_names)}. "
                if req.speaker_names
                else "Speaker identifiers are not provided; use SPEAKER 1, SPEAKER 2, etc. "
            )
            + "Return a JSON list where each item has 'speaker' and 'text'."
        )

        safety_settings=[
            types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HARASSMENT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
            types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold=types.HarmBlockThreshold.BLOCK_NONE),
            types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
            types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
            types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold=types.HarmBlockThreshold.BLOCK_NONE),
        ]

        resp = g.models.generate_content(
            model=MODEL,
            contents=[prompt, f],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=list[TranscriptTurn],
                safety_settings=safety_settings,
            ),
        )

        turns = [TranscriptTurn(**t) for t in json.loads(resp.text)]

        return {
            "transcript_turns": turns,
            "gemini_file_name": f.name,
            "r2_object_key": r2_object_key,
        }
    finally:
        os.unlink(tmp_path)

@app.post("/generate_docx")
async def generate_docx(req: DocxReq):
    buf = make_docx(req.title_data, req.transcript_turns)
    fn_base = req.title_data.get("FILE_NAME", "transcript").split(".")[0]
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{fn_base}_transcript.docx"'},
    )

@app.post("/cleanup/{gemini_file_name}")
async def cleanup(
    gemini_file_name: str,
    r2_object_key: Optional[str] = None,
    g: genai.Client = Depends(gem),
):
    await delete_gem(gemini_file_name, g)
    if r2_object_key:
        await delete_r2(r2_object_key)
    return {"message": "Cleanup attempted"}

@app.post("/cleanup_r2/{r2_object_key}")
async def cleanup_r2(r2_object_key: str):
    await delete_r2(r2_object_key)
    return {"message": "Cleanup attempted"}

@app.get("/")
def root():
    return {"message": "API running"}