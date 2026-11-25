// Compression and checks of uploaded photos (services/image.service.js). No database, nothing is written.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, mock, test } from "node:test";
import sharp from "sharp";
import "./helpers.js";

const { prepareParticipantPhoto } = await import("../src/services/image.service.js");
const { copyPath, jsonReplacer } = await import("../src/services/media.service.js");

const KB = 1024;
const noise = (width, height, channels = 3) => sharp(crypto.randomBytes(width * height * channels), { raw: { width, height, channels } });
const prepare = (buffer) => prepareParticipantPhoto({ buffer, size: buffer.length, originalname: "a.jpg" });
const meta = (buffer) => sharp(buffer).metadata();

describe("photo compression", () => {
  test("a photo of more than 5 MB becomes a display copy of at most 300 KB and a thumbnail of at most 100 KB", async () => {
    const photo = await noise(3000, 2250).jpeg({ quality: 92 }).toBuffer(); // pure noise: the worst case to compress
    assert.ok(photo.length > 5 * KB * KB, `${photo.length} bytes`);
    const out = await prepare(photo);
    assert.ok(out.display.length <= 300 * KB, `display ${out.display.length}`);
    assert.ok(out.thumb.length <= 100 * KB, `thumb ${out.thumb.length}`);
    assert.equal((await meta(out.display)).format, "webp");
    assert.equal((await meta(out.display)).width, out.width);
    assert.equal(out.buffer, photo, "the original is kept as it was");
  });

  test("an ordinary photo keeps its full display size", async () => {
    const photo = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#884422" } }).jpeg().toBuffer();
    const out = await prepare(photo);
    assert.deepEqual([out.width, out.height], [1600, 1200]);
    const thumb = await meta(out.thumb);
    assert.deepEqual([thumb.width, thumb.height], [480, 360]);
  });

  test("EXIF orientation is applied and all metadata dropped", async () => {
    // Left half red, right half blue, marked "rotate 90° clockwise": upright, red is on top
    const photo = await sharp({ create: { width: 1000, height: 600, channels: 3, background: "#0000ff" } })
      .composite([{ input: { create: { width: 500, height: 600, channels: 3, background: "#ff0000" } }, left: 0, top: 0 }])
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const out = await prepare(photo);
    assert.deepEqual([out.width, out.height], [600, 1000]);
    for (const copy of [out.display, out.thumb]) {
      const m = await meta(copy);
      assert.ok(m.height > m.width);
      assert.equal(m.orientation, undefined);
      assert.equal(m.exif, undefined);
      const { data, info } = await sharp(copy).raw().toBuffer({ resolveWithObject: true });
      const at = (y) => (y * info.width + (info.width >> 1)) * info.channels;
      assert.ok(data[at(10)] > 200, "red on top");
      assert.ok(data[at(info.height - 10) + 2] > 200, "blue below");
    }
  });

  test("PNG with transparency, 16-bit PNG, greyscale and CMYK JPEG are accepted with their colours", async () => {
    const solid = (channels, background) => sharp({ create: { width: 800, height: 600, channels, background } });
    const grey = async (buffer) => {
      const { data } = await sharp((await prepare(buffer)).display).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return data[0];
    };
    assert.ok(Math.abs((await grey(await solid(3, "#808080").png().toBuffer())) - 128) < 6);
    assert.ok(Math.abs((await grey(await solid(3, "#808080").toColourspace("rgb16").png().toBuffer())) - 128) < 6, "16-bit");
    assert.ok(Math.abs((await grey(await solid(3, "#808080").greyscale().jpeg().toBuffer())) - 128) < 6, "greyscale");
    assert.ok(Math.abs((await grey(await solid(3, "#808080").toColourspace("cmyk").jpeg().toBuffer())) - 128) < 40, "CMYK");
    await prepare(await solid(4, { r: 255, g: 0, b: 0, alpha: 0.5 }).png().toBuffer());
  });

  test("a 108-megapixel JPEG is accepted; an oversized PNG is refused with its reason", async () => {
    const huge = (width, height) => sharp({ create: { width, height, channels: 3, background: "#336633" }, limitInputPixels: false });
    const out = await prepare(await huge(12000, 9000).jpeg({ quality: 60 }).toBuffer());
    assert.deepEqual([out.width, out.height], [1600, 1200]);
    await assert.rejects(prepare(await huge(9000, 6000).png({ compressionLevel: 1 }).toBuffer()), /at most 50 megapixels/);
  });

  test("a thumbnail that cannot be made is replaced by the display copy, and the photo is still accepted", async () => {
    const photo = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#884422" } }).jpeg().toBuffer();
    const { webp } = sharp.prototype;
    // every encoding at the thumbnail's quality fails; the display copy's (82) does not
    const broken = mock.method(sharp.prototype, "webp", function encode(options) {
      if (options?.quality === 72) throw new Error("edge case");
      return webp.call(this, options);
    });
    try {
      const out = await prepare(photo);
      assert.equal(out.thumb, out.display);
      assert.equal((await meta(out.thumb)).format, "webp");
    } finally {
      broken.mock.restore();
    }
  });

  test("HEIC is refused by name, truncated files as invalid", async () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(64)]);
    await assert.rejects(prepare(heic), /HEIC photos are not supported/);
    const photo = await noise(1000, 800).jpeg().toBuffer();
    await assert.rejects(prepare(photo.subarray(0, photo.length / 2)), /not a valid image/);
  });
});

describe("image references", () => {
  test("only this app's photo copies are resolved; other URLs and unsafe paths are left alone", () => {
    assert.equal(copyPath("/uploads/registrations/2026-11/a_t.webp"), "registrations/2026-11/a_t.webp");
    for (const ref of ["/uploads/../.env", "/uploads/registrations/2026-11/../../x.webp", "/uploads/25-11-2026/A_98/A_98 (1).jpg", "/images/award/w.webp", "https://example.com/a.jpg", "", null]) {
      assert.equal(copyPath(ref), null, String(ref));
    }
    for (const ref of ["https://example.com/a.jpg", "/uploads/forts/a.webp", "text", 5, null]) assert.equal(jsonReplacer("k", ref), ref);
  });
});
