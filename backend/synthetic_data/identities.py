SYNTHETIC_PHYSICIAN_NPIS = {
    "physician-jung": "9900000001",
    "physician-onadeko": "9900000002",
    "physician-patel": "9900000003",
    "physician-rossi": "9900000004",
    "physician-chen": "9900000005",
    "physician-alvarez": "9900000006",
    "physician-brooks": "9900000007",
    "physician-wu": "9900000008",
    "physician-kim": "9900000009",
    "physician-reed": "9900000010",
    "physician-cha": "9900000011",
}


def synthetic_agent_id(physician_id: str) -> str:
    return f"agent-{SYNTHETIC_PHYSICIAN_NPIS[physician_id]}"
