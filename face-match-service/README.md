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
