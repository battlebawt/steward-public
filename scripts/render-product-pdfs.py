#!/usr/bin/env python3
"""Render the maintained Steward product and architecture Markdown to PDFs."""

from __future__ import annotations

import html
import re
from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output/pdf"
DOCUMENTS = {
    ROOT / "docs/implementation/BETA-ARCHITECTURE.md": "Steward-Beta-Architecture.pdf",
    ROOT / "docs/BACKEND-SPEC.md": "Steward-Backend-Specification.pdf",
    ROOT / "docs/FRONTEND-SPEC.md": "Steward-Frontend-Specification.pdf",
    ROOT / "docs/BUILDABILITY-REVIEW.md": "Steward-Buildability-Review.pdf",
    ROOT / "docs/implementation/MARKET-ROUTES.md": "Steward-Market-Routes.pdf",
    ROOT / "docs/MARKETING-BRIEF.md": "Steward-Marketing-Brief.pdf",
    ROOT / "PRODUCT-ROADMAP.md": "Steward-Product-Roadmap.pdf",
}
FONT_CHOICES = [
    (Path("/System/Library/Fonts/Supplemental/Arial.ttf"), Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf")),
    (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")),
]
normal, bold = next(((n, b) for n, b in FONT_CHOICES if n.exists() and b.exists()), (None, None))
if normal and bold:
    pdfmetrics.registerFont(TTFont("StewardText", str(normal)))
    pdfmetrics.registerFont(TTFont("StewardTextBold", str(bold)))
    pdfmetrics.registerFontFamily("StewardText", normal="StewardText", bold="StewardTextBold")
else:
    pdfmetrics.registerFontFamily("Helvetica", normal="Helvetica", bold="Helvetica-Bold")
    FONT = "Helvetica"
    FONT_BOLD = "Helvetica-Bold"
if normal and bold:
    FONT = "StewardText"
    FONT_BOLD = "StewardTextBold"

BASE = ParagraphStyle(
    "body", fontName=FONT, fontSize=9.2, leading=13.3,
    textColor=colors.HexColor("#203042"), spaceAfter=7, alignment=TA_LEFT,
)
TITLE = ParagraphStyle(
    "title", parent=BASE, fontName=FONT_BOLD, fontSize=19,
    leading=24, spaceBefore=18, spaceAfter=17, keepWithNext=True,
    textColor=colors.HexColor("#122B43"),
)
H2 = ParagraphStyle(
    "h2", parent=BASE, fontName=FONT_BOLD, fontSize=12,
    leading=16, spaceBefore=12, spaceAfter=5, keepWithNext=True,
    textColor=colors.HexColor("#0E4A61"),
)
H3 = ParagraphStyle(
    "h3", parent=H2, fontSize=10, leading=14,
    spaceBefore=10, spaceAfter=5,
)
LIST = ParagraphStyle("list", parent=BASE, leftIndent=16, firstLineIndent=-11, spaceAfter=4)
QUOTE = ParagraphStyle(
    "quote", parent=BASE, leftIndent=14, rightIndent=10,
    borderColor=colors.HexColor("#8BAEB9"), borderWidth=0.5,
    borderPadding=7, backColor=colors.HexColor("#F4F8F8"),
)
CARD = ParagraphStyle(
    "card", parent=BASE, leftIndent=12, rightIndent=10,
    borderColor=colors.HexColor("#D9E5E9"), borderWidth=0.5,
    borderPadding=8, backColor=colors.HexColor("#F4F8F8"),
    spaceAfter=8, leading=13,
)
CODE = ParagraphStyle(
    "code", parent=BASE, fontName="Courier", fontSize=7.3, leading=10,
    leftIndent=10, rightIndent=8, spaceAfter=1,
    textColor=colors.HexColor("#27424E"),
)

INLINE = re.compile(r"(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)")


def inline(text: str) -> str:
    pieces = []
    for part in INLINE.split(text):
        if part.startswith("**") and part.endswith("**"):
            pieces.append(f"<b>{html.escape(part[2:-2])}</b>")
        elif part.startswith("`") and part.endswith("`"):
            pieces.append(f"<font color='#275B70'>{html.escape(part[1:-1])}</font>")
        elif part.startswith("[") and "](" in part and part.endswith(")"):
            label, target = part[1:-1].split("](", 1)
            if target.startswith("https://"):
                pieces.append(f"<link href='{html.escape(target, quote=True)}' color='#146181'>{html.escape(label)}</link>")
            else:
                pieces.append(html.escape(label))
        else:
            pieces.append(html.escape(part))
    return "".join(pieces)


def cells(line: str) -> list[str]:
    return [piece.strip() for piece in line.strip().strip("|").split("|")]


def elements(markdown: str):
    lines = markdown.splitlines()
    result = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line or line in ("---", ">"):
            i += 1
            continue
        if line.startswith("```"):
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code_line = lines[i].rstrip() or " "
                result.append(Paragraph(html.escape(code_line), CODE))
                i += 1
            i += 1
            result.append(Spacer(1, 8))
            continue
        if line.startswith("|") and i + 1 < len(lines) and re.fullmatch(r"[| :\-]+", lines[i + 1].strip()):
            headers = cells(line)
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                values = cells(lines[i])
                fields = []
                for column, value in enumerate(values):
                    heading = headers[column] if column < len(headers) else f"Field {column + 1}"
                    fields.append(f"<b>{inline(heading)}:</b> {inline(value)}")
                result.append(KeepTogether([Paragraph("<br/>".join(fields), CARD)]))
                i += 1
            continue
        heading = re.match(r"^(#{1,3})\s+(.*)$", line)
        if heading:
            result.append(Paragraph(inline(heading.group(2)), {1: TITLE, 2: H2, 3: H3}[len(heading.group(1))]))
            i += 1
            continue
        bullet = re.match(r"^(?:- |\d+\. )(.*)$", line)
        if bullet:
            prefix = "-" if line.startswith("-") else line.split(".", 1)[0] + "."
            result.append(Paragraph(f"{prefix}  {inline(bullet.group(1))}", LIST))
            i += 1
            continue
        if line.startswith("> "):
            result.append(KeepTogether([Paragraph(inline(line[2:]), QUOTE)]))
            i += 1
            continue
        paragraph = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not (
            lines[i].lstrip().startswith(("#", "|", "- "))
            or re.match(r"^\d+\. ", lines[i].strip())
        ):
            paragraph.append(lines[i].strip())
            i += 1
        result.append(KeepTogether([Paragraph(inline(" ".join(paragraph)), BASE)]))
    return result


def render(source: Path, destination: Path):
    title = source.stem.replace("-", " ").title()
    doc = SimpleDocTemplate(
        str(destination), pagesize=A4, rightMargin=53, leftMargin=53,
        topMargin=50, bottomMargin=45, title=f"Steward - {title}", author="Steward",
    )

    def furniture(canvas, rendered):
        canvas.saveState()
        width, height = A4
        canvas.setStrokeColor(colors.HexColor("#B7CAD0"))
        canvas.line(53, height - 37, width - 53, height - 37)
        canvas.setFillColor(colors.HexColor("#0E4A61"))
        canvas.setFont(FONT_BOLD, 8)
        canvas.drawString(53, height - 28, "STEWARD")
        canvas.setFont(FONT, 8)
        canvas.drawRightString(width - 53, height - 28, title.upper())
        canvas.setFillColor(colors.HexColor("#536576"))
        canvas.drawString(53, 30, f"Internal product planning - {date.today():%d %B %Y}")
        canvas.drawRightString(width - 53, 30, str(rendered.page))
        canvas.restoreState()

    doc.build(elements(source.read_text(encoding="utf-8")), onFirstPage=furniture, onLaterPages=furniture)


if __name__ == "__main__":
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for source, name in DOCUMENTS.items():
        destination = OUTPUT / name
        render(source, destination)
        print(destination)
