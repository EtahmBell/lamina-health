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
    "physician-sanchez": "9900000012",
    "physician-islam": "9900000013",
    "physician-muhammad": "9900000014",
    "physician-guechtouli": "9900000015",
    "physician-mithel": "9900000016",
    "physician-daniels": "9900000017",
    "physician-miller": "9900000018",
    "physician-da-fieno-m": "9900000019",
    "physician-da-fieno-l": "9900000020",
    "physician-murtuza-lanier": "9900000021",
    "physician-nakajima": "9900000022",
    "physician-ramanathan": "9900000023",
    "physician-park": "9900000024",
    "physician-desai": "9900000025",
    "physician-chen-emily": "9900000026",
    "physician-rahman": "9900000027",
    "physician-rosen": "9900000028",
}


def synthetic_agent_id(physician_id: str) -> str:
    return f"agent-{SYNTHETIC_PHYSICIAN_NPIS[physician_id]}"
