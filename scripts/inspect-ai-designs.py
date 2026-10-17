#!/usr/bin/env python3
"""Read-only Illustrator/PDF design-source inspector for Cloudig.

The inspector never modifies source artwork. It rejects source roots that are
reparse points, resolves every declared source inside its supplied root, and
keeps reports/renders outside all art roots and input paths.

Machine readability and rendering are evidence capabilities, not completion
judgements. Working AI files must declare which completed regions may be used;
blank, placeholder, unfinished and unannotated regions remain non-authoritative.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Iterable


REPORT_SCHEMA = "cloudig/design-inspection-report/0.2.0"
ALLOWED_STATUSES = {"completed", "working"}
SOURCE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
PRIVATE_BLOCK_PATTERN = re.compile(r"^/AIPrivateData(\d+)$")
WINDOWS_REPARSE_POINT = 0x400
BOX_SPECS = (
    ("media_box", "mediabox", "/MediaBox"),
    ("crop_box", "cropbox", "/CropBox"),
    ("bleed_box", "bleedbox", "/BleedBox"),
    ("trim_box", "trimbox", "/TrimBox"),
    ("art_box", "artbox", "/ArtBox"),
)


class InspectionConfigurationError(ValueError):
    """Raised before any output is written when the requested topology is unsafe."""


@dataclass(frozen=True)
class SourceRoot:
    label: str
    lexical: Path
    resolved: Path


@dataclass(frozen=True)
class Renderer:
    name: str
    version: str | None
    executable: Path | None = None


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rounded(value: float) -> int | float:
    integer = round(value)
    return integer if abs(value - integer) < 0.001 else round(value, 4)


def package_version(distribution: str) -> str | None:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return None


def pdf_object(value: Any) -> Any:
    return value.get_object() if hasattr(value, "get_object") else value


def object_identity(reference: Any) -> tuple[Any, ...]:
    if hasattr(reference, "idnum"):
        return ("indirect", int(reference.idnum), int(getattr(reference, "generation", 0)))
    value = pdf_object(reference)
    indirect = getattr(value, "indirect_reference", None)
    if indirect is not None and hasattr(indirect, "idnum"):
        return ("indirect", int(indirect.idnum), int(getattr(indirect, "generation", 0)))
    return ("direct", id(value))


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def paths_overlap(first: Path, second: Path) -> bool:
    return is_relative_to(first, second) or is_relative_to(second, first)


def same_file_if_present(first: Path, second: Path) -> bool:
    try:
        return first.exists() and second.exists() and os.path.samefile(first, second)
    except OSError:
        return False


def lexical_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def is_reparse_point(path: Path) -> bool:
    try:
        stat_result = path.lstat()
    except FileNotFoundError:
        return False
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction) and is_junction():
        return True
    return bool(getattr(stat_result, "st_file_attributes", 0) & WINDOWS_REPARSE_POINT)


def prepare_source_root(label: str, path: Path) -> SourceRoot:
    lexical = lexical_absolute(path)
    if is_reparse_point(lexical):
        raise InspectionConfigurationError(f"root {label} is a reparse point")
    if not lexical.exists() or not lexical.is_dir():
        raise InspectionConfigurationError(f"root {label} is not an existing directory")
    return SourceRoot(label=label, lexical=lexical, resolved=lexical.resolve(strict=True))


def reject_reparse_directories(root: SourceRoot, candidate_parent: Path) -> None:
    relative = candidate_parent.relative_to(root.lexical)
    current = root.lexical
    directories = [current]
    for component in relative.parts:
        current = current / component
        directories.append(current)
    for directory in directories:
        try:
            directory.lstat()
        except FileNotFoundError:
            break
        if is_reparse_point(directory):
            raise InspectionConfigurationError(
                f"source directory under root {root.label} is a reparse point"
            )
        if not directory.is_dir():
            break


def resolve_source_path(root: SourceRoot, relative_file: str) -> Path:
    if not isinstance(relative_file, str) or not relative_file.strip() or "\x00" in relative_file:
        raise InspectionConfigurationError(f"source path under root {root.label} is invalid")
    relative = Path(relative_file)
    if (
        relative.is_absolute()
        or PureWindowsPath(relative_file).is_absolute()
        or PurePosixPath(relative_file).is_absolute()
    ):
        raise InspectionConfigurationError(f"source path under root {root.label} must be relative")
    lexical = lexical_absolute(root.lexical / relative)
    if not is_relative_to(lexical, root.lexical):
        raise InspectionConfigurationError(f"source path escapes declared root {root.label}")
    reject_reparse_directories(root, lexical.parent)
    resolved = lexical.resolve(strict=False)
    if not is_relative_to(resolved, root.resolved):
        raise InspectionConfigurationError(f"source path resolves outside declared root {root.label}")
    try:
        lexical.lstat()
    except FileNotFoundError:
        pass
    else:
        if is_reparse_point(lexical):
            raise InspectionConfigurationError(f"source file under root {root.label} is a reparse point")
    return resolved


def validate_write_topology(
    output: Path,
    render_dir: Path | None,
    roots: Iterable[SourceRoot],
    input_paths: Iterable[Path],
) -> tuple[Path, Path | None]:
    resolved_output = lexical_absolute(output).resolve(strict=False)
    resolved_render = lexical_absolute(render_dir).resolve(strict=False) if render_dir else None
    if resolved_output.exists() and resolved_output.is_dir():
        raise InspectionConfigurationError("output must be a file, not a directory")
    if resolved_render and resolved_render.exists() and not resolved_render.is_dir():
        raise InspectionConfigurationError("render-dir must be a directory, not a file")

    for root in roots:
        if paths_overlap(resolved_output, root.resolved):
            raise InspectionConfigurationError(f"output overlaps art root {root.label}")
        if resolved_render and paths_overlap(resolved_render, root.resolved):
            raise InspectionConfigurationError(f"render-dir overlaps art root {root.label}")

    for input_path in input_paths:
        resolved_input = input_path.resolve(strict=False)
        if paths_overlap(resolved_output, resolved_input) or same_file_if_present(
            resolved_output, resolved_input
        ):
            raise InspectionConfigurationError("output overlaps an input path")
        if resolved_render and paths_overlap(resolved_render, resolved_input):
            raise InspectionConfigurationError("render-dir overlaps an input path")

    if resolved_render and paths_overlap(resolved_output, resolved_render):
        raise InspectionConfigurationError("output and render-dir must not overlap")
    return resolved_output, resolved_render


def validate_render_targets(
    render_dir: Path,
    source_id: str,
    page_count: int,
    input_paths: Iterable[Path],
) -> None:
    if page_count < 1:
        raise InspectionConfigurationError(f"{source_id}: render page count must be positive")
    for page_index in range(1, page_count + 1):
        lexical_target = render_dir / f"{source_id}-p{page_index}.png"
        resolved_target = lexical_target.resolve(strict=False)
        if not is_relative_to(resolved_target, render_dir):
            raise InspectionConfigurationError(f"{source_id}: render target resolves outside render-dir")
        if lexical_target.exists() and lexical_target.is_dir():
            raise InspectionConfigurationError(f"{source_id}: render target is an existing directory")
        if is_reparse_point(lexical_target):
            raise InspectionConfigurationError(f"{source_id}: render target is a reparse point")
        for input_path in input_paths:
            resolved_input = input_path.resolve(strict=False)
            if paths_overlap(resolved_target, resolved_input) or same_file_if_present(
                lexical_target, input_path
            ):
                raise InspectionConfigurationError(f"{source_id}: render target overlaps an input path")


def page_box(page: Any, attribute: str, pdf_key: str) -> dict[str, Any]:
    explicit = pdf_key in page
    box = getattr(page, attribute)
    coordinates = [
        rounded(float(box.left)),
        rounded(float(box.bottom)),
        rounded(float(box.right)),
        rounded(float(box.top)),
    ]
    return {
        "coordinates": coordinates,
        "width_points": rounded(float(box.right) - float(box.left)),
        "height_points": rounded(float(box.top) - float(box.bottom)),
        "explicit": explicit,
    }


def normalized_font_name(value: Any) -> tuple[str, bool]:
    raw = str(value or "").lstrip("/")
    subset = bool(re.match(r"^[A-Z]{6}\+", raw))
    return re.sub(r"^[A-Z]{6}\+", "", raw), subset


def font_descriptors(font: Any) -> tuple[list[Any], list[str]]:
    descriptors: list[Any] = []
    descendant_subtypes: list[str] = []
    direct = pdf_object(font.get("/FontDescriptor")) if hasattr(font, "get") else None
    if direct:
        descriptors.append(direct)
    descendants = pdf_object(font.get("/DescendantFonts")) if hasattr(font, "get") else None
    if descendants:
        for reference in descendants:
            descendant = pdf_object(reference)
            if not hasattr(descendant, "get"):
                continue
            subtype = descendant.get("/Subtype")
            if subtype:
                descendant_subtypes.append(str(subtype).lstrip("/"))
            descriptor = pdf_object(descendant.get("/FontDescriptor"))
            if descriptor:
                descriptors.append(descriptor)
    return descriptors, sorted(set(descendant_subtypes), key=str.casefold)


def describe_font(reference: Any, resource_name: str, page_index: int) -> dict[str, Any]:
    font = pdf_object(reference)
    base_font = font.get("/BaseFont") if hasattr(font, "get") else None
    name, subset = normalized_font_name(base_font or resource_name)
    subtype = str(font.get("/Subtype") or "").lstrip("/") if hasattr(font, "get") else ""
    descriptors, descendant_subtypes = font_descriptors(font)
    embedding_streams: set[str] = set()
    for descriptor in descriptors:
        for key in ("/FontFile", "/FontFile2", "/FontFile3"):
            if descriptor.get(key) is not None:
                embedding_streams.add(key.lstrip("/"))
    type3_self_contained = subtype == "Type3" and font.get("/CharProcs") is not None
    if type3_self_contained:
        embedding_streams.add("Type3CharProcs")
    return {
        "name": name,
        "base_font": str(base_font or "").lstrip("/"),
        "subset": subset,
        "subtype": subtype,
        "descendant_subtypes": descendant_subtypes,
        "embedded": bool(embedding_streams),
        "embedding_streams": sorted(embedding_streams),
        "to_unicode": font.get("/ToUnicode") is not None if hasattr(font, "get") else False,
        "resource_names": {resource_name.lstrip("/")},
        "pages": {page_index},
    }


def collect_fonts(
    resources_reference: Any,
    found: dict[tuple[Any, ...], dict[str, Any]],
    visited_resources: set[tuple[Any, ...]],
    page_index: int,
) -> None:
    if resources_reference is None:
        return
    resource_identity = object_identity(resources_reference)
    if resource_identity in visited_resources:
        return
    visited_resources.add(resource_identity)
    resources = pdf_object(resources_reference)
    if not hasattr(resources, "get"):
        return

    fonts = pdf_object(resources.get("/Font"))
    if fonts:
        for resource_name, reference in fonts.items():
            identity = object_identity(reference)
            if identity not in found:
                found[identity] = describe_font(reference, str(resource_name), page_index)
            else:
                found[identity]["resource_names"].add(str(resource_name).lstrip("/"))
                found[identity]["pages"].add(page_index)

    for container_key in ("/XObject", "/Pattern"):
        container = pdf_object(resources.get(container_key))
        if not container:
            continue
        for reference in container.values():
            item = pdf_object(reference)
            nested = item.get("/Resources") if hasattr(item, "get") else None
            if nested:
                collect_fonts(nested, found, visited_resources, page_index)


def finalize_fonts(found: dict[tuple[Any, ...], dict[str, Any]]) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for value in found.values():
        item = dict(value)
        item["resource_names"] = sorted(item["resource_names"], key=str.casefold)
        item["pages"] = sorted(item["pages"])
        items.append(item)
    items.sort(key=lambda item: (item["name"].casefold(), item["subtype"], item["resource_names"]))
    embedded_count = sum(1 for item in items if item["embedded"])
    to_unicode_count = sum(1 for item in items if item["to_unicode"])
    return {
        "count": len(items),
        "embedded_count": embedded_count,
        "to_unicode_count": to_unicode_count,
        "all_embedded": embedded_count == len(items) if items else None,
        "all_to_unicode": to_unicode_count == len(items) if items else None,
        "items": items,
    }


def inspect_annotations(page: Any, page_index: int) -> dict[str, Any]:
    annotations = pdf_object(page.get("/Annots"))
    subtypes: Counter[str] = Counter()
    contents: list[str] = []
    broken = 0
    count = 0
    if annotations:
        for reference in annotations:
            count += 1
            try:
                annotation = pdf_object(reference)
                subtype = str(annotation.get("/Subtype") or "Unknown").lstrip("/")
                subtypes[subtype] += 1
                content = annotation.get("/Contents")
                if content is not None:
                    contents.append(str(content))
            except Exception:
                broken += 1
                subtypes["Unreadable"] += 1
    normalized_contents = "\n".join(contents).replace("\r\n", "\n").replace("\r", "\n")
    return {
        "page": page_index,
        "count": count,
        "subtypes": dict(sorted(subtypes.items())),
        "with_contents": len(contents),
        "contents_sha256": sha256_bytes(normalized_contents.encode("utf-8")) if contents else None,
        "unreadable": broken,
    }


def decode_illustrator_metadata(data: bytes) -> tuple[str, str]:
    for encoding in ("utf-8-sig", "gb18030", "cp1252", "latin-1"):
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="replace"), "latin-1-replace"


def extract_document_files(data: bytes) -> tuple[list[str], str]:
    text, encoding = decode_illustrator_metadata(data)
    paths: list[str] = []
    in_document_files = False
    for line in text.splitlines():
        if line.startswith("%%DocumentFiles:"):
            in_document_files = True
            value = line[len("%%DocumentFiles:") :].strip()
            if value:
                paths.append(value)
            continue
        if in_document_files and line.startswith("%%+"):
            value = line[3:].strip()
            if value:
                paths.append(value)
            continue
        if in_document_files:
            break
    return paths, encoding


def windows_path_is_within(candidate: PureWindowsPath, root: PureWindowsPath) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def classify_link_path(raw_path: str, roots: dict[str, SourceRoot]) -> tuple[str, dict[str, Any]]:
    value = raw_path.strip()
    if len(value) >= 2 and value[0] == "(" and value[-1] == ")":
        value = value[1:-1]
    windows = PureWindowsPath(value)
    posix = PurePosixPath(value)
    declared_root: str | None = None
    if windows.is_absolute():
        for label, root in roots.items():
            if windows_path_is_within(windows, PureWindowsPath(str(root.resolved))):
                declared_root = label
                break
        scope = "declared_root" if declared_root else "external_absolute"
        normalized = str(windows).casefold()
        basename = windows.name
        extension = windows.suffix.casefold()
        drive = windows.drive.upper() or None
    elif posix.is_absolute():
        scope = "external_absolute"
        normalized = str(posix)
        basename = posix.name
        extension = posix.suffix.casefold()
        drive = None
    elif re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", value):
        scope = "uri"
        normalized = value
        basename = value.rsplit("/", 1)[-1]
        extension = PurePosixPath(basename).suffix.casefold()
        drive = None
    else:
        scope = "relative"
        normalized = str(windows).casefold()
        basename = windows.name
        extension = windows.suffix.casefold()
        drive = None
    key = f"{scope}\0{normalized}"
    return key, {
        "basename": basename,
        "extension": extension,
        "drive": drive,
        "scope": scope,
        "declared_root": declared_root,
        "path_sha256": sha256_bytes(normalized.encode("utf-8")),
    }


def summarize_linked_assets(paths: list[str], roots: dict[str, SourceRoot]) -> dict[str, Any]:
    assets: dict[str, dict[str, Any]] = {}
    for raw_path in paths:
        key, item = classify_link_path(raw_path, roots)
        if key not in assets:
            assets[key] = {**item, "mentions": 0}
        assets[key]["mentions"] += 1
    items = sorted(
        assets.values(),
        key=lambda item: (
            item["scope"],
            item["drive"] or "",
            item["basename"].casefold(),
            item["path_sha256"],
        ),
    )
    unique_scope_counts = Counter(item["scope"] for item in items)
    mention_scope_counts: Counter[str] = Counter()
    for item in items:
        mention_scope_counts[item["scope"]] += item["mentions"]
    return {
        "mention_count": len(paths),
        "unique_count": len(items),
        "unique_scope_counts": dict(sorted(unique_scope_counts.items())),
        "mention_scope_counts": dict(sorted(mention_scope_counts.items())),
        "items": items,
    }


def inspect_illustrator_piece_info(reader: Any, roots: dict[str, SourceRoot]) -> dict[str, Any]:
    piece_info_pages: list[int] = []
    illustrator_entries = 0
    private_entries = 0
    declared_blocks = 0
    private_stream_count = 0
    private_decoded_bytes = 0
    metadata_stream_count = 0
    metadata_decoded_bytes = 0
    private_digest = hashlib.sha256()
    metadata_digest = hashlib.sha256()
    private_seen: set[tuple[Any, ...]] = set()
    metadata_seen: set[tuple[Any, ...]] = set()
    document_files: list[str] = []
    metadata_encodings: set[str] = set()
    decode_errors = 0

    for page_index, page in enumerate(reader.pages, start=1):
        piece_info = pdf_object(page.get("/PieceInfo"))
        if not piece_info:
            continue
        piece_info_pages.append(page_index)
        illustrator = pdf_object(piece_info.get("/Illustrator")) if hasattr(piece_info, "get") else None
        if not illustrator:
            continue
        illustrator_entries += 1
        private = pdf_object(illustrator.get("/Private")) if hasattr(illustrator, "get") else None
        if not private or not hasattr(private, "items"):
            continue
        private_entries += 1
        try:
            declared_blocks += int(private.get("/NumBlock") or 0)
        except (TypeError, ValueError):
            pass

        def private_sort_key(entry: tuple[Any, Any]) -> tuple[int, str]:
            match = PRIVATE_BLOCK_PATTERN.match(str(entry[0]))
            return (int(match.group(1)) if match else -1, str(entry[0]))

        for key, reference in sorted(private.items(), key=private_sort_key):
            key_text = str(key)
            if key_text == "/AIMetaData":
                identity = object_identity(reference)
                if identity in metadata_seen:
                    continue
                metadata_seen.add(identity)
                stream = pdf_object(reference)
                try:
                    data = bytes(stream.get_data())
                except Exception:
                    decode_errors += 1
                    continue
                metadata_stream_count += 1
                metadata_decoded_bytes += len(data)
                metadata_digest.update(len(data).to_bytes(8, "big"))
                metadata_digest.update(data)
                linked_paths, encoding = extract_document_files(data)
                metadata_encodings.add(encoding)
                document_files.extend(linked_paths)
                continue
            if not PRIVATE_BLOCK_PATTERN.match(key_text):
                continue
            identity = object_identity(reference)
            if identity in private_seen:
                continue
            private_seen.add(identity)
            stream = pdf_object(reference)
            try:
                data = bytes(stream.get_data())
            except Exception:
                decode_errors += 1
                continue
            private_stream_count += 1
            private_decoded_bytes += len(data)
            private_digest.update(key_text.encode("ascii", errors="replace"))
            private_digest.update(len(data).to_bytes(8, "big"))
            private_digest.update(data)

    return {
        "piece_info_present": bool(piece_info_pages),
        "piece_info_pages": piece_info_pages,
        "illustrator_entries": illustrator_entries,
        "private": {
            "entries": private_entries,
            "declared_block_count": declared_blocks,
            "stream_block_count": private_stream_count,
            "decoded_block_bytes": private_decoded_bytes,
            "decoded_blocks_sha256": private_digest.hexdigest() if private_stream_count else None,
            "metadata_stream_count": metadata_stream_count,
            "metadata_decoded_bytes": metadata_decoded_bytes,
            "metadata_sha256": metadata_digest.hexdigest() if metadata_stream_count else None,
            "metadata_encodings": sorted(metadata_encodings),
            "decode_errors": decode_errors,
        },
        "linked_assets": summarize_linked_assets(document_files, roots),
    }


def pixel_sha256(image: Any) -> str:
    normalized = image.convert("RGBA")
    digest = hashlib.sha256()
    digest.update(normalized.width.to_bytes(8, "big"))
    digest.update(normalized.height.to_bytes(8, "big"))
    digest.update(normalized.tobytes())
    return digest.hexdigest()


def render_artifact(path: Path, page_index: int) -> dict[str, Any]:
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError("Pillow is required: python -m pip install pillow") from exc
    with Image.open(path) as image:
        image.load()
        return {
            "page": page_index,
            "file": path.name,
            "width": image.width,
            "height": image.height,
            "mode": image.mode,
            "sha256": sha256_file(path),
            "pixel_sha256_rgba": pixel_sha256(image),
        }


def render_with_pdfium(path: Path, render_dir: Path, source_id: str) -> list[dict[str, Any]]:
    try:
        import pypdfium2 as pdfium
    except ImportError as exc:
        raise RuntimeError("pypdfium2 is unavailable") from exc
    render_dir.mkdir(parents=True, exist_ok=True)
    document = pdfium.PdfDocument(str(path))
    rendered: list[dict[str, Any]] = []
    try:
        for index in range(len(document)):
            page = document[index]
            bitmap = page.render(scale=1.0)
            try:
                image = bitmap.to_pil()
                output = render_dir / f"{source_id}-p{index + 1}.png"
                image.save(output, format="PNG", compress_level=9)
                rendered.append(render_artifact(output, index + 1))
            finally:
                close_bitmap = getattr(bitmap, "close", None)
                if callable(close_bitmap):
                    close_bitmap()
                close_page = getattr(page, "close", None)
                if callable(close_page):
                    close_page()
    finally:
        document.close()
    return rendered


def render_with_poppler(
    path: Path,
    page_count: int,
    render_dir: Path,
    source_id: str,
    executable: Path,
) -> list[dict[str, Any]]:
    render_dir.mkdir(parents=True, exist_ok=True)
    rendered: list[dict[str, Any]] = []
    for page_index in range(1, page_count + 1):
        prefix = render_dir / f"{source_id}-p{page_index}"
        command = [
            str(executable),
            "-f",
            str(page_index),
            "-l",
            str(page_index),
            "-singlefile",
            "-r",
            "72",
            "-cropbox",
            "-png",
            str(path),
            str(prefix),
        ]
        result = subprocess.run(command, capture_output=True, timeout=180, check=False)
        if result.returncode != 0:
            raise RuntimeError(f"pdftoppm failed with exit code {result.returncode}")
        output = prefix.with_suffix(".png")
        if not output.is_file():
            raise RuntimeError("pdftoppm did not produce the expected PNG")
        rendered.append(render_artifact(output, page_index))
    return rendered


def render_pdf(
    path: Path,
    page_count: int,
    render_dir: Path,
    source_id: str,
    renderer: Renderer,
    input_paths: Iterable[Path],
) -> dict[str, Any]:
    validate_render_targets(render_dir, source_id, page_count, input_paths)
    if renderer.name == "pypdfium2":
        pages = render_with_pdfium(path, render_dir, source_id)
        settings = {"scale": 1.0, "format": "PNG", "pixel_hash_mode": "RGBA"}
    elif renderer.name == "poppler-pdftoppm" and renderer.executable is not None:
        pages = render_with_poppler(path, page_count, render_dir, source_id, renderer.executable)
        settings = {
            "dpi": 72,
            "crop_box": True,
            "format": "PNG",
            "single_file_per_page": True,
            "pixel_hash_mode": "RGBA",
        }
    else:
        raise RuntimeError(f"unsupported renderer {renderer.name}")
    return {
        "engine": renderer.name,
        "engine_version": renderer.version,
        "settings": settings,
        "pages": pages,
    }


def inspect_ai(
    path: Path,
    render_dir: Path | None,
    source_id: str,
    roots: dict[str, SourceRoot],
    renderer: Renderer | None,
    input_paths: Iterable[Path],
) -> dict[str, Any]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise RuntimeError("pypdf is required: python -m pip install pypdf") from exc

    with path.open("rb") as stream:
        header = stream.read(8)
    if not header.startswith(b"%PDF-"):
        raise ValueError("Illustrator file is not PDF-compatible")

    reader = PdfReader(str(path), strict=False)
    pages: list[dict[str, Any]] = []
    found_fonts: dict[tuple[Any, ...], dict[str, Any]] = {}
    text_parts: list[str] = []
    annotation_pages: list[dict[str, Any]] = []
    for index, page in enumerate(reader.pages, start=1):
        boxes = {name: page_box(page, attribute, pdf_key) for name, attribute, pdf_key in BOX_SPECS}
        pages.append({
            "index": index,
            "width_points": boxes["media_box"]["width_points"],
            "height_points": boxes["media_box"]["height_points"],
            "boxes": boxes,
        })
        collect_fonts(page.get("/Resources"), found_fonts, set(), index)
        annotation_pages.append(inspect_annotations(page, index))
        try:
            text_parts.append(page.extract_text() or "")
        except Exception as exc:  # Illustrator private structures can be unusual.
            text_parts.append(f"[extract-error:{type(exc).__name__}]")

    layer_names: list[str] = []
    root = pdf_object(reader.trailer.get("/Root"))
    properties = pdf_object(root.get("/OCProperties")) if root else None
    groups = pdf_object(properties.get("/OCGs")) if properties else None
    if groups:
        for reference in groups:
            group = pdf_object(reference)
            name = group.get("/Name") if hasattr(group, "get") else None
            if name:
                layer_names.append(str(name))

    annotation_subtypes: Counter[str] = Counter()
    for page_summary in annotation_pages:
        annotation_subtypes.update(page_summary["subtypes"])
    annotations = {
        "count": sum(page["count"] for page in annotation_pages),
        "subtypes": dict(sorted(annotation_subtypes.items())),
        "with_contents": sum(page["with_contents"] for page in annotation_pages),
        "unreadable": sum(page["unreadable"] for page in annotation_pages),
        "pages": annotation_pages,
    }

    metadata = reader.metadata or {}
    normalized_text = "\n".join(text_parts).replace("\r\n", "\n").replace("\r", "\n")
    result: dict[str, Any] = {
        "pdf_version": header.decode("ascii", errors="replace").strip().removeprefix("%PDF-"),
        "encrypted": bool(reader.is_encrypted),
        "pages": pages,
        "page_count": len(pages),
        "title": str(metadata.get("/Title") or ""),
        "creator": str(metadata.get("/Creator") or ""),
        "producer": str(metadata.get("/Producer") or ""),
        "fonts": finalize_fonts(found_fonts),
        "annotations": annotations,
        "optional_content_layers": sorted(set(layer_names), key=str.casefold),
        "extracted_text_characters": len(normalized_text),
        "extracted_text_sha256": sha256_bytes(normalized_text.encode("utf-8")),
        "illustrator_piece_info": inspect_illustrator_piece_info(reader, roots),
    }

    if render_dir is not None:
        if renderer is None:
            raise RuntimeError("no renderer was selected")
        result["rendering"] = render_pdf(
            path, len(pages), render_dir, source_id, renderer, input_paths
        )
    return result


def inspect_png(path: Path) -> dict[str, Any]:
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError("Pillow is required: python -m pip install pillow") from exc
    with Image.open(path) as image:
        image.load()
        return {
            "width": image.width,
            "height": image.height,
            "mode": image.mode,
            "format": image.format,
            "pixel_sha256_rgba": pixel_sha256(image),
        }


def discover_poppler(explicit: Path | None) -> tuple[dict[str, Any], Path | None]:
    discovery: str | None = None
    candidate: str | None = None
    if explicit is not None:
        discovery = "--pdftoppm"
        candidate = os.fspath(explicit)
    elif os.environ.get("CODEX_PDFTOPPM"):
        discovery = "CODEX_PDFTOPPM"
        candidate = os.environ["CODEX_PDFTOPPM"]
    else:
        located = shutil.which("pdftoppm")
        if located:
            discovery = "PATH"
            candidate = located
    if not candidate:
        return {"available": False, "version": None, "discovery": None}, None
    executable = lexical_absolute(Path(candidate)).resolve(strict=False)
    if not executable.is_file():
        if explicit is not None:
            raise InspectionConfigurationError("--pdftoppm does not name an existing file")
        return {"available": False, "version": None, "discovery": discovery}, None
    version: str | None = None
    try:
        result = subprocess.run(
            [str(executable), "-v"], capture_output=True, timeout=10, check=False, text=True, errors="replace"
        )
        lines = [line.strip() for line in (result.stdout + "\n" + result.stderr).splitlines() if line.strip()]
        version = lines[0] if lines else None
    except (OSError, subprocess.SubprocessError):
        version = None
    return {"available": True, "version": version, "discovery": discovery}, executable


def renderer_inventory(
    requested: str,
    render_requested: bool,
    explicit_pdftoppm: Path | None,
) -> tuple[dict[str, Any], Renderer | None]:
    pdfium_version = package_version("pypdfium2")
    pdfium_available = pdfium_version is not None
    poppler, poppler_executable = discover_poppler(explicit_pdftoppm)
    selected: Renderer | None = None
    if render_requested:
        if requested == "pypdfium2":
            if not pdfium_available:
                raise InspectionConfigurationError("pypdfium2 renderer was requested but is unavailable")
            selected = Renderer("pypdfium2", pdfium_version)
        elif requested == "poppler":
            if not poppler["available"] or poppler_executable is None:
                raise InspectionConfigurationError("Poppler renderer was requested but pdftoppm is unavailable")
            selected = Renderer("poppler-pdftoppm", poppler["version"], poppler_executable)
        elif pdfium_available:
            selected = Renderer("pypdfium2", pdfium_version)
        elif poppler["available"] and poppler_executable is not None:
            selected = Renderer("poppler-pdftoppm", poppler["version"], poppler_executable)
        else:
            raise InspectionConfigurationError(
                "--render-dir requires pypdfium2 or a Poppler pdftoppm executable"
            )
    inventory = {
        "requested": requested,
        "selected": selected.name if selected else None,
        "pypdfium2": {"available": pdfium_available, "version": pdfium_version},
        "poppler_pdftoppm": poppler,
    }
    return inventory, selected


def expected_boxes_for_source(source: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any] | None:
    direct = source.get("expected_page_boxes")
    profile_name = source.get("expected_page_box_profile")
    if direct is not None and profile_name is not None:
        raise InspectionConfigurationError(f"{source['id']}: use a box profile or direct boxes, not both")
    if profile_name is None:
        return direct
    profiles = manifest.get("page_box_profiles") or {}
    if profile_name not in profiles:
        raise InspectionConfigurationError(f"{source['id']}: unknown page-box profile {profile_name}")
    return profiles[profile_name]


def box_coordinates_match(actual: list[int | float], expected: list[int | float]) -> bool:
    if len(actual) != 4 or len(expected) != 4:
        return False
    return all(abs(float(left) - float(right)) <= 0.001 for left, right in zip(actual, expected))


def append_drift(report: dict[str, Any], source: dict[str, Any], message: str, strict_working: bool) -> None:
    if source["status"] == "completed" or strict_working:
        report["errors"].append(message)
    else:
        report["warnings"].append(message)


def validate_source_expectations(
    source: dict[str, Any],
    item: dict[str, Any],
    manifest: dict[str, Any],
    report: dict[str, Any],
    strict_working: bool,
) -> None:
    source_id = source["id"]
    expected_pages = source.get("expected_pages")
    if expected_pages is not None and item.get("page_count") != expected_pages:
        append_drift(
            report,
            source,
            f"{source_id}: expected {expected_pages} page(s), got {item.get('page_count')}",
            strict_working,
        )
    expected_boxes = expected_boxes_for_source(source, manifest)
    if expected_boxes and item.get("pages"):
        for page in item["pages"]:
            for box_name, expected_coordinates in expected_boxes.items():
                actual_box = page["boxes"].get(box_name)
                if actual_box is None or not box_coordinates_match(
                    actual_box["coordinates"], expected_coordinates
                ):
                    actual = actual_box["coordinates"] if actual_box else None
                    append_drift(
                        report,
                        source,
                        f"{source_id}: page {page['index']} {box_name} expected "
                        f"{expected_coordinates}, got {actual}",
                        strict_working,
                    )
    expected_points = source.get("expected_page_points")
    if expected_points and item.get("pages"):
        actual = [item["pages"][0]["width_points"], item["pages"][0]["height_points"]]
        if actual != expected_points:
            append_drift(
                report,
                source,
                f"{source_id}: expected media page {expected_points}, got {actual}",
                strict_working,
            )
    expected_dimensions = source.get("expected_dimensions")
    if expected_dimensions:
        actual_dimensions = [item.get("width"), item.get("height")]
        if actual_dimensions != expected_dimensions:
            append_drift(
                report,
                source,
                f"{source_id}: expected image {expected_dimensions}, got {actual_dimensions}",
                strict_working,
            )
    expected_external = source.get("expected_external_link_basenames")
    if expected_external is not None:
        linked = item.get("illustrator_piece_info", {}).get("linked_assets", {}).get("items", [])
        actual_external = sorted(
            {entry["basename"] for entry in linked if entry["scope"] == "external_absolute"},
            key=str.casefold,
        )
        expected_sorted = sorted(set(expected_external), key=str.casefold)
        if actual_external != expected_sorted:
            append_drift(
                report,
                source,
                f"{source_id}: external linked-asset basename drift",
                strict_working,
            )


def validate_manifest(manifest: dict[str, Any], roots: dict[str, SourceRoot]) -> list[dict[str, Any]]:
    sources = manifest.get("sources")
    if not isinstance(sources, list) or not sources:
        raise InspectionConfigurationError("manifest sources must be a non-empty array")
    declared_roots = manifest.get("roots")
    if not isinstance(declared_roots, dict) or not declared_roots:
        raise InspectionConfigurationError("manifest roots must be a non-empty object")
    seen_ids: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for source in sources:
        if not isinstance(source, dict):
            raise InspectionConfigurationError("each manifest source must be an object")
        source_id = source.get("id")
        if not isinstance(source_id, str) or not SOURCE_ID_PATTERN.fullmatch(source_id):
            raise InspectionConfigurationError("source ids must use ASCII letters, digits, dot, underscore or hyphen")
        if source_id in seen_ids:
            raise InspectionConfigurationError(f"duplicate source id {source_id}")
        seen_ids.add(source_id)
        status = source.get("status")
        if status not in ALLOWED_STATUSES:
            raise InspectionConfigurationError(
                f"{source_id}: status must be completed or working; accepted is not a machine status"
            )
        root_label = source.get("root")
        if root_label not in declared_roots:
            raise InspectionConfigurationError(f"{source_id}: root {root_label} is not declared by the manifest")
        if root_label not in roots:
            raise InspectionConfigurationError(f"{source_id}: root {root_label} was not supplied")
        if source.get("kind") not in {"ai_pdf", "png"}:
            raise InspectionConfigurationError(f"{source_id}: unsupported kind {source.get('kind')}")
        if not isinstance(source.get("authority"), str) or not source["authority"]:
            raise InspectionConfigurationError(f"{source_id}: authority is required")
        if status == "completed" and "expected_sha256" not in source:
            raise InspectionConfigurationError(f"{source_id}: completed sources require expected_sha256")
        if status == "working" and "observed_sha256" not in source:
            raise InspectionConfigurationError(f"{source_id}: working sources require observed_sha256")
        if status == "working" and source.get("kind") == "ai_pdf" and not source.get("evidence_scope"):
            raise InspectionConfigurationError(
                f"{source_id}: working AI sources require an explicit evidence_scope"
            )
        exclusions = source.get("non_authoritative_regions")
        if exclusions is not None and (
            not isinstance(exclusions, list)
            or not exclusions
            or any(not isinstance(value, str) or not value for value in exclusions)
        ):
            raise InspectionConfigurationError(
                f"{source_id}: non_authoritative_regions must be a non-empty string array"
            )
        if "expected_sha256" in source and "observed_sha256" in source:
            raise InspectionConfigurationError(
                f"{source_id}: declare expected_sha256 or observed_sha256, not both"
            )
        expected_hash = source.get("expected_sha256") or source.get("observed_sha256")
        if expected_hash is not None and not re.fullmatch(r"[0-9a-f]{64}", str(expected_hash)):
            raise InspectionConfigurationError(f"{source_id}: expected SHA-256 is invalid")
        expected_boxes_for_source(source, manifest)
        normalized.append(source)
    return normalized


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect Cloudig AI/PNG design sources without modifying them")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--project-art-root", required=True, type=Path)
    parser.add_argument("--auxiliary-art-root", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--render-dir", type=Path)
    parser.add_argument(
        "--renderer",
        choices=("auto", "pypdfium2", "poppler"),
        default="auto",
        help="Renderer for --render-dir; auto prefers pypdfium2 then Poppler",
    )
    parser.add_argument("--pdftoppm", type=Path, help="Explicit Poppler pdftoppm executable")
    parser.add_argument("--strict-working", action="store_true", help="Treat working-source drift as an error")
    return parser.parse_args(argv)


def run(args: argparse.Namespace) -> tuple[dict[str, Any], Path]:
    manifest_path = lexical_absolute(args.manifest).resolve(strict=True)
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes.decode("utf-8"))

    roots = {"project_art": prepare_source_root("project_art", args.project_art_root)}
    if args.auxiliary_art_root:
        roots["auxiliary_art"] = prepare_source_root("auxiliary_art", args.auxiliary_art_root)
    sources = validate_manifest(manifest, roots)
    source_paths = {
        source["id"]: resolve_source_path(roots[source["root"]], source["file"])
        for source in sources
    }
    input_paths = [manifest_path, *source_paths.values()]
    output, render_dir = validate_write_topology(
        args.output,
        args.render_dir,
        roots.values(),
        input_paths,
    )
    renderer_evidence, renderer = renderer_inventory(args.renderer, render_dir is not None, args.pdftoppm)
    if render_dir is not None:
        for source in sources:
            if source["kind"] != "ai_pdf":
                continue
            expected_pages = source.get("expected_pages")
            if not isinstance(expected_pages, int) or isinstance(expected_pages, bool):
                raise InspectionConfigurationError(
                    f"{source['id']}: expected_pages is required for render preflight"
                )
            validate_render_targets(render_dir, source["id"], expected_pages, input_paths)

    report: dict[str, Any] = {
        "schema": REPORT_SCHEMA,
        "manifest_schema": manifest.get("schema"),
        "manifest_sha256": sha256_bytes(manifest_bytes),
        "runtime": {
            "python": platform.python_version(),
            "implementation": platform.python_implementation(),
            "platform": platform.system(),
            "libraries": {
                "pypdf": package_version("pypdf"),
                "Pillow": package_version("Pillow"),
                "pypdfium2": package_version("pypdfium2"),
            },
            "renderers": renderer_evidence,
        },
        "interpretation": {
            "readable_or_renderable_does_not_imply_design_completion": True,
            "working_ai_evidence_is_limited_to_manifest_scope": True,
        },
        "sources": [],
        "duplicate_sha256_groups": [],
        "errors": [],
        "warnings": [],
    }

    hash_sources: defaultdict[str, list[str]] = defaultdict(list)
    for source in sources:
        source_id = source["id"]
        path = source_paths[source_id]
        item: dict[str, Any] = {
            "id": source_id,
            "root": source["root"],
            "file": source["file"],
            "kind": source["kind"],
            "status": source["status"],
            "authority": source["authority"],
        }
        if source.get("evidence_scope"):
            item["evidence_scope"] = source["evidence_scope"]
        if source.get("non_authoritative_regions"):
            item["non_authoritative_regions"] = source["non_authoritative_regions"]
        if not path.is_file():
            report["errors"].append(f"{source_id}: source file is missing")
            item["missing"] = True
            report["sources"].append(item)
            continue
        item["size_bytes"] = path.stat().st_size
        item["sha256"] = sha256_file(path)
        hash_sources[item["sha256"]].append(source_id)
        expected_hash = source.get("expected_sha256") or source.get("observed_sha256")
        if expected_hash and item["sha256"] != expected_hash:
            append_drift(
                report,
                source,
                f"{source_id}: SHA-256 drift ({item['sha256']})",
                args.strict_working,
            )
        try:
            if source["kind"] == "ai_pdf":
                item.update(inspect_ai(path, render_dir, source_id, roots, renderer, input_paths))
            else:
                item.update(inspect_png(path))
            validate_source_expectations(source, item, manifest, report, args.strict_working)
            linked = item.get("illustrator_piece_info", {}).get("linked_assets", {})
            external_count = linked.get("unique_scope_counts", {}).get("external_absolute", 0)
            if external_count:
                report["warnings"].append(
                    f"{source_id}: {external_count} unique linked-asset path(s) are outside declared roots"
                )
        except Exception as exc:
            report["errors"].append(f"{source_id}: {type(exc).__name__}: {exc}")
        report["sources"].append(item)

    report["duplicate_sha256_groups"] = [
        {"sha256": digest, "count": len(source_ids), "source_ids": sorted(source_ids)}
        for digest, source_ids in sorted(hash_sources.items())
        if len(source_ids) > 1
    ]
    report["summary"] = {
        "source_count": len(report["sources"]),
        "completed_count": sum(1 for item in report["sources"] if item["status"] == "completed"),
        "working_count": sum(1 for item in report["sources"] if item["status"] == "working"),
        "duplicate_group_count": len(report["duplicate_sha256_groups"]),
        "warning_count": len(report["warnings"]),
        "error_count": len(report["errors"]),
    }
    atomic_write_json(output, report)
    return report, output


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        report, output = run(args)
    except (InspectionConfigurationError, FileNotFoundError, json.JSONDecodeError) as exc:
        print(f"Cloudig design inspection configuration error: {exc}", file=sys.stderr)
        return 2
    print(
        f"Cloudig design inspection: {len(report['sources'])} source(s), "
        f"{len(report['warnings'])} warning(s), {len(report['errors'])} error(s)"
    )
    print(output)
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
