"""Synthetic intake fixtures (run 3): fictional referral PDFs and scanned-looking images, every one
marked SYNTHETIC. No real patient, clinician, practice or number. Used by the backend tests, the e2e
seed and the provider eval; written to a gitignored directory, never committed.

    python -m scripts.intake_fixtures data/e2e/intake-fixtures

PDFs are minimal hand-written PDF 1.4 files whose text is drawn with plain text operators (so the
dev `local` extractor can read them, as Textract would). The "scans" are grayscale PNGs drawn with
a 5x7 bitmap font plus speckle noise; they carry their text in a `lamina-synthetic-ocr` metadata
chunk that ONLY the dev extractor reads (it stands in for OCR; production uses Textract).
"""

from __future__ import annotations

import json
import random
import struct
import sys
import zlib
from pathlib import Path

WATERMARK = "SYNTHETIC TEST DOCUMENT - NOT A REAL PATIENT"

# ----------------------------------------------------------------------------- fixtures

THYROID_REFERRAL = [
    [WATERMARK, "REFERRAL - FAX", "From: Dr. Casey Placeholder (SYNTHETIC)", "Referring practice: Placeholder Family Medicine",
     "Fax: (555) 010-0199", "Patient: Robin Lumen-Synthetic", "DOB: 1968-03-14", "MRN: SYN-20417",
     "Referral type: Thyroid nodule", "Reason for referral: Incidental 1.8 cm thyroid nodule on CT."],
    [WATERMARK, "RESULTS", "Neck ultrasound 2026-10-12: 1.8 cm TI-RADS 4 nodule, right lobe.",
     "TSH 1.2 mIU/L (2026-10-30)."],
]
MULTI_REFERRAL_FAX = [
    [WATERMARK, "REFERRAL 1 OF 2", "From: Dr. Jamie Example (SYNTHETIC)", "Referring practice: Example Primary Care",
     "Fax: (555) 010-0142", "Patient: Quinn Harbor-Synthetic", "DOB: 1975-07-02", "Referral type: Osteoporosis",
     "Reason for referral: Low bone density on screening."],
    [WATERMARK, "RESULTS", "DXA 2026-09-01: lumbar spine T-score -2.7."],
    [WATERMARK, "REFERRAL 2 OF 2", "From: Dr. Jamie Example (SYNTHETIC)", "Referring practice: Example Primary Care",
     "Fax: (555) 010-0142", "Patient: Sasha Meridian-Synthetic", "DOB: 1990-11-21", "Referral type: Thyroid nodule",
     "Reason for referral: Palpable thyroid nodule, no imaging yet."],
    [WATERMARK, "NOTES", "Thyroid ultrasound not yet done.", "TSH 2.4 mIU/L (2026-11-05)."],
]
INFO_REPLY = [
    [WATERMARK, "RE: REQUEST FOR INFORMATION", "From: Dr. Casey Placeholder (SYNTHETIC)", "Fax: (555) 010-0199",
     "Patient: Robin Lumen-Synthetic", "DOB: 1968-03-14", "Requested item attached:", "TSH result 1.4 mIU/L (2026-11-02)."],
]
OLD_RESULT = [
    [WATERMARK, "REFERRAL", "From: Dr. Morgan Testcase (SYNTHETIC)", "Referring practice: Testcase Internal Medicine",
     "Fax: (555) 010-0177", "Patient: Avery Quartz-Synthetic", "DOB: 1959-05-30", "Referral type: Diabetes management",
     "Reason for referral: Type 2 diabetes not at goal.", "Last HbA1c 7.6% drawn 2025-12-01.",
     "Renal function: creatinine 0.9 mg/dL on 2026-09-30."],
]
DUPLICATE_A = [
    [WATERMARK, "REFERRAL", "From: Dr. Riley Sample (SYNTHETIC)", "Referring practice: Sample Health Partners",
     "Fax: (555) 010-0123", "Patient: Rivera-Synthetic, Morgan", "DOB: 1980-04-12", "Patient phone: (555) 010-0456",
     "Referral type: Osteoporosis", "Reason for referral: Low bone density after wrist fracture."],
]
DUPLICATE_B_SCAN = [
    [WATERMARK, "REFERRAL", "FROM: DR. RILEY SAMPLE (SYNTHETIC)", "REFERRING PRACTICE: SAMPLE HEALTH PARTNERS",
     "PATIENT: MORGAN RIVERA-SYNTHETIC", "DATE OF BIRTH: 04/12/1980", "PATIENT PHONE: 555-010-0456",
     "REFERRAL TYPE: OSTEOPOROSIS", "REASON FOR REFERRAL: FOLLOW-UP OF LOW BONE DENSITY."],
]
JUNK_FAX_SCAN = [
    [WATERMARK, "SPECIAL OFFER!", "TONER CARTRIDGES 50% OFF", "CALL 555-010-0000 TODAY",
     "REPLY STOP TO OPT OUT"],
]
OSTEO_SCAN = [
    [WATERMARK, "REFERRAL", "FROM: DR. TAYLOR DEMO (SYNTHETIC)", "PATIENT: JORDAN ASH-SYNTHETIC", "DOB: 1955-01-09",
     "REFERRAL TYPE: OSTEOPOROSIS", "REASON FOR REFERRAL: LOW BONE DENSITY.", "DXA REPORT 2026-06-15: T-SCORE -2.9."],
]


# --------------------------------------------------------------------------------- PDF


def _pdf_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf(pages: list[list[str]]) -> bytes:
    """A minimal PDF 1.4: one uncompressed content stream per page, Helvetica, one line per Td."""
    objects: list[bytes] = []
    font_id = 3
    page_ids, content_ids = [], []
    next_id = 4
    for _ in pages:
        page_ids.append(next_id)
        content_ids.append(next_id + 1)
        next_id += 2
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for lines, page_id, content_id in zip(pages, page_ids, content_ids, strict=True):
        ops = ["BT", "/F1 11 Tf", "50 750 Td", "14 TL"]
        for index, line in enumerate(lines):
            if index:
                ops.append("0 -18 Td")
            ops.append(f"({_pdf_escape(line)}) Tj")
        ops.append("ET")
        stream = "\n".join(ops).encode("latin-1")
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_id} 0 R "
                       f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode())
        objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


# ------------------------------------------------------------------------- "scanned" PNG

_FONT = {  # 5x7 bitmap glyphs, rows top to bottom
    "A": "01110 10001 10001 11111 10001 10001 10001", "B": "11110 10001 10001 11110 10001 10001 11110",
    "C": "01111 10000 10000 10000 10000 10000 01111", "D": "11110 10001 10001 10001 10001 10001 11110",
    "E": "11111 10000 10000 11110 10000 10000 11111", "F": "11111 10000 10000 11110 10000 10000 10000",
    "G": "01111 10000 10000 10011 10001 10001 01111", "H": "10001 10001 10001 11111 10001 10001 10001",
    "I": "01110 00100 00100 00100 00100 00100 01110", "J": "00111 00010 00010 00010 00010 10010 01100",
    "K": "10001 10010 10100 11000 10100 10010 10001", "L": "10000 10000 10000 10000 10000 10000 11111",
    "M": "10001 11011 10101 10101 10001 10001 10001", "N": "10001 11001 10101 10011 10001 10001 10001",
    "O": "01110 10001 10001 10001 10001 10001 01110", "P": "11110 10001 10001 11110 10000 10000 10000",
    "Q": "01110 10001 10001 10001 10101 10010 01101", "R": "11110 10001 10001 11110 10100 10010 10001",
    "S": "01111 10000 10000 01110 00001 00001 11110", "T": "11111 00100 00100 00100 00100 00100 00100",
    "U": "10001 10001 10001 10001 10001 10001 01110", "V": "10001 10001 10001 10001 10001 01010 00100",
    "W": "10001 10001 10001 10101 10101 10101 01010", "X": "10001 10001 01010 00100 01010 10001 10001",
    "Y": "10001 10001 01010 00100 00100 00100 00100", "Z": "11111 00001 00010 00100 01000 10000 11111",
    "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11110 00001 00001 01110 00001 00001 11110",
    "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00010 01100",
    ":": "00000 00100 00100 00000 00100 00100 00000", "-": "00000 00000 00000 11111 00000 00000 00000",
    "/": "00001 00010 00010 00100 01000 01000 10000", ".": "00000 00000 00000 00000 00000 01100 01100",
    ",": "00000 00000 00000 00000 01100 00100 01000", "(": "00010 00100 01000 01000 01000 00100 00010",
    ")": "01000 00100 00010 00010 00010 00100 01000", "%": "11001 11010 00010 00100 01000 01011 10011",
    "!": "00100 00100 00100 00100 00100 00000 00100", " ": "00000 00000 00000 00000 00000 00000 00000",
}


def _png(width: int, height: int, pixels: bytearray, text_chunks: dict[str, str]) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(pixels[row * width:(row + 1) * width]) for row in range(height))
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
    for key, value in text_chunks.items():
        out += chunk(b"tEXt", key.encode("latin-1") + b"\x00" + value.encode("utf-8"))
    return out + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def make_scan(lines: list[str], *, seed: int = 7, scale: int = 2) -> bytes:
    """A scanned-looking grayscale page: off-white paper, speckles, a slight vertical drift."""
    width = max(620, 70 + max(len(line) for line in lines) * 6 * scale)
    height = 60 + len(lines) * 9 * scale + 40
    rng = random.Random(seed)
    pixels = bytearray(rng.choice((236, 240, 244, 246)) for _ in range(width * height))
    for _ in range(width * height // 60):  # speckle noise
        pixels[rng.randrange(width * height)] = rng.choice((150, 180, 205))
    y = 40
    for line in lines:
        x = 30 + rng.randint(-2, 2)
        drift = rng.choice((0, 0, 1))
        for char in line.upper():
            glyph = _FONT.get(char, _FONT[" "]).split()
            for row, bits in enumerate(glyph):
                for column, bit in enumerate(bits):
                    if bit == "1":
                        for dy in range(scale):
                            for dx in range(scale):
                                px, py = x + column * scale + dx, y + row * scale + dy + drift
                                if 0 <= px < width and 0 <= py < height:
                                    pixels[py * width + px] = rng.choice((25, 40, 55))
            x += 6 * scale
        y += 9 * scale
    ocr = json.dumps({"pages": ["\n".join(lines)], "note": "synthetic text for the dev extractor only"})
    return _png(width, height, pixels, {"lamina-synthetic-ocr": ocr, "Comment": WATERMARK})


FIXTURES = {
    "thyroid-referral.pdf": lambda: make_pdf(THYROID_REFERRAL),
    "multi-referral-fax.pdf": lambda: make_pdf(MULTI_REFERRAL_FAX),
    "info-reply-fax.pdf": lambda: make_pdf(INFO_REPLY),
    "old-result-referral.pdf": lambda: make_pdf(OLD_RESULT),
    "duplicate-patient-a.pdf": lambda: make_pdf(DUPLICATE_A),
    "duplicate-patient-b-scan.png": lambda: make_scan(DUPLICATE_B_SCAN[0], seed=11),
    "junk-fax-scan.png": lambda: make_scan(JUNK_FAX_SCAN[0], seed=3),
    "osteoporosis-referral-scan.png": lambda: make_scan(OSTEO_SCAN[0], seed=5),
}


def write_all(directory: Path) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    written = []
    for name, build in FIXTURES.items():
        path = directory / name
        path.write_bytes(build())
        written.append(path)
    return written


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/e2e/intake-fixtures")
    for path in write_all(target):
        print(path)
