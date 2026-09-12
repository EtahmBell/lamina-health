import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.consult import router as consult_router

app = FastAPI(title="Lamina Consult Network", version="0.1.0")
origins = [
    item.strip()
    for item in os.getenv(
        "LAMINA_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",")
    if item.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Accept", "Content-Type"],
)
app.include_router(consult_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "data_mode": "synthetic"}

