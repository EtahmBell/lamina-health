from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.consult import router as consult_router
from backend.api.engagement import router as engagement_router
from backend.api.physician_sandbox import router as physician_sandbox_router
from backend.api.specialist import router as specialist_router
from backend.api.workspace import router as workspace_router
from backend.demo_workspace import configured_cors_origins
from backend.provider_network import router as provider_network_router

app = FastAPI(title="Lamina Consult Network", version="0.1.0")
origins = configured_cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=[
        "Accept",
        "Authorization",
        "Content-Type",
        "X-Lamina-Workspace-Bootstrap",
    ],
)
app.include_router(consult_router)
app.include_router(workspace_router)
app.include_router(specialist_router)
app.include_router(engagement_router)
app.include_router(provider_network_router)
app.include_router(physician_sandbox_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "data_mode": "synthetic"}
