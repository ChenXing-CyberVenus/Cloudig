"""Pixel-exact PNG/WebP experiment; never edits source assets or signed payloads.

Run with the available Pillow/libwebp runtime. Output is an independent, new
directory, not a publish destination. Lossy/near-lossless encoding is not used.
"""
import argparse
import concurrent.futures
import hashlib
import io
import json
import pathlib
import struct
import time
import zlib

import PIL
from PIL import Image, features


def digest(data):
    return hashlib.sha256(data).hexdigest()


def chunks(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    offset = 8
    result = []
    while offset < len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        body = data[offset + 8:offset + 8 + size]
        crc = struct.unpack_from(">I", data, offset + 8 + size)[0]
        assert zlib.crc32(kind + body) & 0xffffffff == crc
        result.append((kind, body))
        offset += size + 12
    assert offset == len(data) and result[-1][0] == b"IEND"
    return result


def deflate_png(items):
    # Keep filtering, pixel bytes and every non-IDAT chunk exactly unchanged.
    raw = zlib.decompress(b"".join(body for kind, body in items if kind == b"IDAT"))
    packed = zlib.compress(raw, level=9)
    assert zlib.decompress(packed) == raw
    output = bytearray(b"\x89PNG\r\n\x1a\n")
    emitted = False
    for kind, body in items:
        if kind == b"IDAT":
            if emitted:
                continue
            emitted = True
            body = packed
        output.extend(struct.pack(">I", len(body)) + kind + body)
        output.extend(struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff))
    return bytes(output)


def rgba(data):
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        assert getattr(image, "n_frames", 1) == 1
        return image.size, image.convert("RGBA").tobytes(), image.info


def measure(file, source, output):
    started = time.monotonic()
    relative = file.relative_to(source)
    original = file.read_bytes()
    items = chunks(original)
    color = {kind: body for kind, body in items if kind in (b"gAMA", b"cHRM", b"sRGB", b"iCCP")}
    dimensions, pixels, info = rgba(original)
    png = deflate_png(items)
    assert rgba(png)[:2] == (dimensions, pixels)
    assert [(k, v) for k, v in chunks(png) if k != b"IDAT"] == [(k, v) for k, v in items if k != b"IDAT"]

    # WebP has an 8-bit channel model. Do not claim losslessness for 16-bit PNG.
    depth = next(body[8] for kind, body in items if kind == b"IHDR")
    reasons = []
    if depth != 8:
        reasons.append("non-8-bit source")
    if not info.get("icc_profile"):
        if b"gAMA" in color and struct.unpack(">I", color[b"gAMA"])[0] != 45455:
            reasons.append("non-sRGB gamma without ICC")
        srgb_primaries = (31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000)
        if b"cHRM" in color and struct.unpack(">8I", color[b"cHRM"]) != srgb_primaries:
            reasons.append("non-sRGB primaries without ICC")

    encoded_webp = None
    if not reasons:
        with Image.open(io.BytesIO(original)) as image:
            image.load()
            metadata = {key: info[key] for key in ("icc_profile", "exif", "xmp") if info.get(key)}
            buffer = io.BytesIO()
            image.save(buffer, "WEBP", lossless=True, quality=100, method=6, exact=True, **metadata)
            encoded_webp = buffer.getvalue()
        size, decoded, webp_info = rgba(encoded_webp)
        assert size == dimensions and decoded == pixels, str(relative)
        assert webp_info.get("icc_profile", b"") == info.get("icc_profile", b""), str(relative)

    candidates = [(len(original), "original", original), (len(png), "png-deflate9", png)]
    if encoded_webp is not None:
        candidates.append((len(encoded_webp), "webp-lossless-exact", encoded_webp))
    _, choice, chosen = min(candidates, key=lambda item: item[0])
    chosen_relative = relative.with_suffix(".webp") if choice == "webp-lossless-exact" else relative
    destination = output / "selected" / chosen_relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(chosen)
    assert digest(file.read_bytes()) == digest(original), "Source changed during measurement"
    return {
        "file": relative.as_posix(), "dimensions": list(dimensions), "mode_bits": depth,
        "source_bytes": len(original), "source_sha256": digest(original),
        "rgba_sha256": digest(pixels), "icc_sha256": digest(info["icc_profile"]) if info.get("icc_profile") else None,
        "color_chunks": [kind.decode() for kind in color],
        "png_deflate9_bytes": len(png), "webp_bytes": len(encoded_webp) if encoded_webp is not None else None,
        "webp_skipped": reasons, "selected": choice, "selected_file": chosen_relative.as_posix(),
        "selected_bytes": len(chosen), "selected_sha256": digest(chosen),
        "all_rgba_equal": True, "seconds": round(time.monotonic() - started, 3),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--files", nargs="*")
    parser.add_argument("--workers", type=int, default=4, choices=range(1, 9))
    args = parser.parse_args()
    source = pathlib.Path(args.source).resolve(strict=True)
    output = pathlib.Path(args.output).resolve()
    assert not output.is_relative_to(source) and not source.is_relative_to(output)
    output.mkdir(parents=True, exist_ok=False)
    files = [source / item for item in args.files] if args.files else sorted(source.rglob("*.png"))
    assert files and len(set(files)) == len(files)
    for file in files:
        assert file.resolve(strict=True).is_relative_to(source) and file.suffix.lower() == ".png"
        assert not file.is_symlink()
    started = time.monotonic()
    records = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(measure, file, source, output) for file in files]
        for completed in concurrent.futures.as_completed(futures):
            row = completed.result()
            records.append(row)
            print(json.dumps({"done": len(records), "total": len(files), "file": row["file"], "before": row["source_bytes"], "after": row["selected_bytes"], "method": row["selected"]}, ensure_ascii=False), flush=True)
    records.sort(key=lambda row: row["file"])
    before = sum(row["source_bytes"] for row in records)
    after = sum(row["selected_bytes"] for row in records)
    report = {
        "source": str(source), "pillow": PIL.__version__, "webp": features.version("webp"),
        "lossless": True, "exact_transparent_rgb": True, "source_unchanged": True,
        "count": len(records), "before_bytes": before, "selected_bytes": after,
        "saved_bytes": before - after, "saved_percent": round((before - after) / before * 100, 2),
        "seconds": round(time.monotonic() - started, 3), "files": records,
    }
    (output / "measurement.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "files"}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
