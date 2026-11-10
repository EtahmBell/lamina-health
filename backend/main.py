from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.consult import router as consult_router
from backend.api.engagement import router as engagement_router
from backend.api.eval_harness import router as eval_harness_router
from backend.api.physician_onboarding import internal_router as pilot_admin_router
from backend.api.physician_onboarding import router as physician_onboarding_router
from backend.api.physician_sandbox import router as physician_sandbox_router
from backend.api.referral_preferences import router as referral_preferences_router
from backend.api.referrals import router as referrals_router
from backend.api.specialist import router as specialist_router
from backend.api.workspace import router as workspace_router
from backend.demo_workspace import configured_cors_origins
from backend.pilot.api import internal_router as pilot_metrics_router
from backend.pilot.api import router as pilot_practice_router
from backend.pilot.mode import ProductMode, product_mode
from backend.pilot.public_api import router as pilot_public_router
from backend.provider_network import router as provider_network_router

# Synthetic demo surface: anonymous Lucy/Chen/Iain workspaces, fixture patients,
# Consult Network, the controlled synthetic roster, and the demo eval harness.
DEMO_ROUTERS = (
    consult_router,
    workspace_router,
    specialist_router,
    engagement_router,
    provider_network_router,
    physician_onboarding_router,
    physician_sandbox_router,
    pilot_admin_router,
    referrals_router,
    referral_preferences_router,
    eval_harness_router,
)
# Real pilot surface: authenticated onboarding, the internal approval gate, and
# practice-scoped pilot routes. Nothing here can resolve a demo persona or patient.
PILOT_ROUTERS = (
    physician_onboarding_router,
    pilot_admin_router,
    pilot_practice_router,
    pilot_metrics_router,
    pilot_public_router,
)


def create_app(mode: str | None = None) -> FastAPI:
    resolved: ProductMode = product_mode(mode)
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if resolved == "pilot":
            # Apply every additive pilot migration at startup (fail loudly), not on first use.
            from backend.pilot.api import get_pilot_services

            get_pilot_services()
        yield

    application = FastAPI(
        title="Lamina Consult Network" if resolved == "demo" else "Lamina Pilot", version="0.1.0",
        lifespan=lifespan,
    )
    application.state.product_mode = resolved
    application.add_middleware(
        CORSMiddleware,
        allow_origins=configured_cors_origins(),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Accept",
            "Authorization",
            "Content-Type",
            "X-Filename",
            "X-Lamina-Workspace-Bootstrap",
        ],
    )
    for router in PILOT_ROUTERS if resolved == "pilot" else DEMO_ROUTERS:
        application.include_router(router)

    @application.get("/health")
    def health() -> dict[str, str]:
        if resolved == "demo":
            return {"status": "ok", "data_mode": "synthetic"}  # Unchanged demo contract.
        return {"status": "ok", "data_mode": "pilot", "product_mode": "pilot"}

    return application


app = create_app()
