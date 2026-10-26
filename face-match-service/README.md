# Face Match Service (InsightFace, self-hosted)

Check-in paytida yuborilgan selfie'ni xodimning profil rasmi bilan
solishtiradi. Biometrik ma'lumot serverdan tashqariga chiqmaydi.

## Lokal ishga tushirish (test uchun)

```bash
cd face-match-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Birinchi `/verify` so'rovida InsightFace `buffalo_l` modeli avtomatik
yuklab olinadi (~350MB, internet kerak). Docker orqali ishga
tushirilganda bu `insightface_models` volume'ida keshlanadi — konteyner
qayta ko'tarilganda qayta yuklanmaydi.

## API

### `GET /health`
`{"status": "ok"}`

### `POST /verify`
```json
{
  "reference_image": "<base64 JPEG/PNG>",
  "live_image": "<base64 JPEG/PNG>",
  "threshold": 0.36
}
```

Javob:
```json
{
  "match": true,
  "similarity": 0.512,
  "referenceFaceFound": true,
  "liveFaceFound": true
}
```

`match=false` bo'lishi ikki holatda: yuzlar mos kelmadi (`similarity <
threshold`), yoki yuzlardan biri aniqlanmadi
(`referenceFaceFound`/`liveFaceFound: false`) — bu ikkalasini backend
tomonda (`FaceMatchService`) ajratib ko'rib chiqiladi.

### `POST /detect`

Internal profile-photo validation. Accepts `{"image":"<base64 JPEG/PNG>"}` and returns only `{"faceCount":1}`. Zero faces or more than one face is rejected by the backend before profile/file/outbox changes. Detection failures return a temporary error and never bypass validation, independently of attendance's `FACE_MATCH_ENABLED` / lenient settings. No images or embeddings are persisted by this endpoint.

Run contract tests with `python -m unittest test_detect.py`. Upload and terminal-delivery gates share a bounded in-memory content-hash cache and deduplicate simultaneous requests; invalid legacy images are also blocked before terminal writes.
