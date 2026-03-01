import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeChatInputImages } from "../input-images.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-input-images-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeChatInputImages", () => {
  it("normalizes base64 and dataUrl entries", () => {
    const base64 = Buffer.from("hello").toString("base64");
    const images = normalizeChatInputImages([
      {
        mimeType: "image/png",
        dataBase64: base64
      },
      {
        dataUrl: `data:image/jpeg;base64,${base64}`
      }
    ]);

    expect(images).toHaveLength(2);
    expect(images[0]).toEqual({
      mimeType: "image/png",
      dataBase64: base64
    });
    expect(images[1]).toEqual({
      mimeType: "image/jpeg",
      dataBase64: base64
    });
  });

  it("loads image bytes from path relative to cwd", () => {
    const dir = makeTempDir();
    const imagePath = path.join(dir, "sample.png");
    fs.writeFileSync(imagePath, Buffer.from("img-bytes"));

    const images = normalizeChatInputImages(
      [
        {
          path: "sample.png"
        }
      ],
      { cwd: dir }
    );

    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[0]?.dataBase64).toBe(Buffer.from("img-bytes").toString("base64"));
  });

  it("rejects invalid payloads", () => {
    expect(() => normalizeChatInputImages({})).toThrow("images must be an array");
    expect(() =>
      normalizeChatInputImages([
        {
          dataBase64: "***"
        }
      ])
    ).toThrow("invalid characters");
  });
});
