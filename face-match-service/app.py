"""
MaternityCare Face Match Service
=================================
Check-in paytida yuborilgan selfie'ni xodimning profil rasmi bilan
solishtiradi (InsightFace buffalo_l, CPU inference).

Bu xizmat ATTENDANCE oqimidan MUSTAQIL, ixtiyoriy qatlam — agar bu
container ishlamay qolsa, backend (FaceMatchService) FACE_MATCH_MODE
sozlamasiga qarab check-in'ni bloklamasligi ham mumkin (fail-open).
Biometrik ma'lumot (yuz embedding) hech qayerga tashqariga
yuborilmaydi — hammasi shu server ichida qoladi.
"""
import base64
import io
import logging
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("face-match")

_analyzer = None


def get_analyzer():
    """InsightFace modelini bir marta CPU xotirasiga yuklaydi."""
    global _analyzer
    if _analyzer is None:
        from insightface.app import FaceAnalysis

        logger.info("InsightFace buffalo_l modeli yuklanmoqda (CPU)...")
        _analyzer = FaceAnalysis(
            name="buffalo_l",
            providers=["CPUExecutionProvider"],
        )
        _analyzer.prepare(ctx_id=-1, det_size=(640, 640))
        logger.info("InsightFace buffalo_l modeli tayyor")
    return _analyzer


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """HTTP so'rov qabul qilishdan oldin modelni to'liq tayyorlaydi.

    Oldingi lazy-load birinchi xodim check-in'ida 5–15 soniya olib,
    backendning timeoutiga tushib qolishi mumkin edi. Startup muvaffaqiyatsiz
    bo'lsa container health'ga chiqmaydi va Compose uni qayta ishga tushiradi.
    """
    try:
        get_analyzer()
    except Exception:
        logger.exception("InsightFace modelini startup'da yuklab bo'lmadi")
        raise
    yield


app = FastAPI(title="MaternityCare Face Match Service", lifespan=lifespan)


class VerifyRequest(BaseModel):
    reference_image: str  # base64 (xodim profil rasmi)
    live_image: str  # base64 (check-in selfie)
    threshold: float = 0.36


class VerifyResponse(BaseModel):
    match: bool
    similarity: float
    referenceFaceFound: bool
    liveFaceFound: bool


def decode_image(b64: str) -> np.ndarray:
    try:
        raw = base64.b64decode(b64)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Rasmni o'qib bo'lmadi: {e}")
    # PIL RGB -> InsightFace/OpenCV BGR kutadi
    return np.array(img)[:, :, ::-1].copy()


def largest_face(faces):
    """Bir nechta yuz aniqlansa — eng kattasini (kamera oldida turgan
    odamniki bo'lish ehtimoli yuqori) tanlaydi."""
    if not faces:
        return None
    return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    return float(np.dot(a, b))


@app.get("/health")
def health():
    # lifespan modelni yuklamasdan turib serverni tinglashga qo'ymaydi.
    return {"status": "ready"}


@app.post("/verify", response_model=VerifyResponse)
def verify(req: VerifyRequest):
    analyzer = get_analyzer()

    ref_img = decode_image(req.reference_image)
    live_img = decode_image(req.live_image)

    ref_faces = analyzer.get(ref_img)
    live_faces = analyzer.get(live_img)

    ref_face = largest_face(ref_faces)
    live_face = largest_face(live_faces)

    if ref_face is None or live_face is None:
        return VerifyResponse(
            match=False,
            similarity=0.0,
            referenceFaceFound=ref_face is not None,
            liveFaceFound=live_face is not None,
        )

    similarity = cosine_similarity(
        ref_face.normed_embedding, live_face.normed_embedding
    )

    return VerifyResponse(
        match=similarity >= req.threshold,
        similarity=round(similarity, 4),
        referenceFaceFound=True,
        liveFaceFound=True,
    )
