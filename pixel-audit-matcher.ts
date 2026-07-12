import { PNG } from "npm:pngjs@7.0.0";
import jpeg from "npm:jpeg-js@0.4.4";
import { Buffer } from "node:buffer";

export type ImageData = { width: number; height: number; data: Uint8Array };

export function decodeImage(bytes: Uint8Array, path: string): ImageData {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const image = PNG.sync.read(Buffer.from(bytes));
    return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
  }
  throw new Error(`Unsupported image type: ${path}`);
}

export function inkMask(image: ImageData): Uint8Array {
  const output = new Uint8Array(image.width * image.height);
  for (let pixel = 0, offset = 0; pixel < output.length; pixel++, offset += 4) {
    const luminance = (77 * image.data[offset] + 150 * image.data[offset + 1] + 29 * image.data[offset + 2]) >> 8;
    output[pixel] = image.data[offset + 3] > 10 && luminance < 244 ? 1 : 0;
  }
  return output;
}

function downsample(mask: Uint8Array, width: number, height: number, factor = 12) {
  const resultWidth = Math.ceil(width / factor);
  const resultHeight = Math.ceil(height / factor);
  const output = new Uint8Array(resultWidth * resultHeight);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (mask[y * width + x]) output[Math.floor(y / factor) * resultWidth + Math.floor(x / factor)] = 1;
    }
  }
  return { mask: output, width: resultWidth, height: resultHeight, factor };
}

function resizeMask(mask: Uint8Array, width: number, height: number, resultWidth: number, resultHeight: number) {
  const output = new Uint8Array(resultWidth * resultHeight);
  for (let y = 0; y < resultHeight; y++) {
    const sourceY = Math.min(height - 1, Math.floor(y * height / resultHeight));
    for (let x = 0; x < resultWidth; x++) {
      output[y * resultWidth + x] = mask[sourceY * width + Math.min(width - 1, Math.floor(x * width / resultWidth))];
    }
  }
  return output;
}

function sampleInk(mask: Uint8Array, limit: number) {
  const all: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) all.push(i);
  if (all.length <= limit) return all;
  const output: number[] = [];
  for (let i = 0; i < limit; i++) output.push(all[Math.floor(i * all.length / limit)]);
  return output;
}

function nearbyInk(mask: Uint8Array, width: number, height: number, x: number, y: number) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const testX = x + dx;
      const testY = y + dy;
      if (testX >= 0 && testY >= 0 && testX < width && testY < height && mask[testY * width + testX]) return 1;
    }
  }
  return 0;
}

export function locateCrop(pageMask: Uint8Array, pageWidth: number, pageHeight: number, assetMask: Uint8Array, assetWidth: number, assetHeight: number) {
  const page = downsample(pageMask, pageWidth, pageHeight);
  const asset = downsample(assetMask, assetWidth, assetHeight);
  const maximumFit = Math.min(page.width / asset.width, page.height / asset.height);
  const candidates = [0.42, 0.5, 0.58, 0.66, 0.74, 0.82, 0.9, 1, maximumFit * 0.88, maximumFit]
    .map(value => Math.round(value * 100) / 100)
    .filter((value, index, values) => value > 0.24 && value <= maximumFit + 0.01 && values.indexOf(value) === index);
  let best = { score: -1, x: 0, y: 0, width: 0, height: 0, scale: 1 };
  for (const scale of candidates) {
    const width = Math.max(2, Math.round(asset.width * scale));
    const height = Math.max(2, Math.round(asset.height * scale));
    if (width > page.width || height > page.height) continue;
    const resized = resizeMask(asset.mask, asset.width, asset.height, width, height);
    const roughPoints = sampleInk(resized, 45);
    if (!roughPoints.length) continue;
    const stride = Math.max(2, Math.floor(Math.min(width, height) / 7));
    let roughX = 0;
    let roughY = 0;
    let roughScore = -1;
    for (let y = 0; y <= page.height - height; y += stride) {
      for (let x = 0; x <= page.width - width; x += stride) {
        let hits = 0;
        for (const point of roughPoints) {
          const pointY = Math.floor(point / width);
          const pointX = point - pointY * width;
          hits += nearbyInk(page.mask, page.width, page.height, x + pointX, y + pointY);
        }
        const score = hits / roughPoints.length;
        if (score > roughScore) {
          roughScore = score;
          roughX = x;
          roughY = y;
        }
      }
    }
    const finePoints = sampleInk(resized, 120);
    for (let y = Math.max(0, roughY - stride); y <= Math.min(page.height - height, roughY + stride); y++) {
      for (let x = Math.max(0, roughX - stride); x <= Math.min(page.width - width, roughX + stride); x++) {
        let hits = 0;
        for (const point of finePoints) {
          const pointY = Math.floor(point / width);
          const pointX = point - pointY * width;
          hits += nearbyInk(page.mask, page.width, page.height, x + pointX, y + pointY);
        }
        const score = hits / finePoints.length;
        if (score > best.score) {
          best = {
            score,
            x: x * page.factor,
            y: y * page.factor,
            width: width * page.factor,
            height: height * page.factor,
            scale,
          };
        }
      }
    }
  }
  return best;
}

export function edgeEvidence(pageMask: Uint8Array, pageWidth: number, pageHeight: number, crop: { x: number; y: number; width: number; height: number }) {
  const x = Math.max(0, Math.round(crop.x));
  const y = Math.max(0, Math.round(crop.y));
  const width = Math.min(pageWidth - x, Math.round(crop.width));
  const height = Math.min(pageHeight - y, Math.round(crop.height));
  const distance = 8;
  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  let crossing = 0;
  for (let testY = Math.max(0, y - distance); testY < y; testY++) for (let testX = x; testX < x + width; testX++) top += pageMask[testY * pageWidth + testX];
  for (let testY = y + height; testY < Math.min(pageHeight, y + height + distance); testY++) for (let testX = x; testX < x + width; testX++) bottom += pageMask[testY * pageWidth + testX];
  for (let testX = Math.max(0, x - distance); testX < x; testX++) for (let testY = y; testY < y + height; testY++) left += pageMask[testY * pageWidth + testX];
  for (let testX = x + width; testX < Math.min(pageWidth, x + width + distance); testX++) for (let testY = y; testY < y + height; testY++) right += pageMask[testY * pageWidth + testX];
  for (let testX = x; testX < x + width; testX++) {
    if (y > 0 && pageMask[y * pageWidth + testX] && pageMask[(y - 1) * pageWidth + testX]) crossing++;
    if (y + height < pageHeight && pageMask[(y + height - 1) * pageWidth + testX] && pageMask[(y + height) * pageWidth + testX]) crossing++;
  }
  for (let testY = y; testY < y + height; testY++) {
    if (x > 0 && pageMask[testY * pageWidth + x] && pageMask[testY * pageWidth + x - 1]) crossing++;
    if (x + width < pageWidth && pageMask[testY * pageWidth + x + width - 1] && pageMask[testY * pageWidth + x + width]) crossing++;
  }
  return { top, bottom, left, right, crossing };
}

export function parsePageNumber(path: string) {
  const matches = [...path.matchAll(/(?:source_page|full_page|context_page|question_page|markscheme_page|page)[_-]?(\d{1,3})/gi)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}
