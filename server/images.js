'use strict';

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_TOTAL_BYTES = 12_000_000;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

class ImageValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageValidationError';
    this.status = 400;
  }
}

function sniffMime(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

function normalizeImage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ImageValidationError('Invalid image attachment');
  const mimeType = typeof value.mimeType === 'string' ? value.mimeType.toLowerCase() : '';
  const fileName = typeof value.fileName === 'string' ? value.fileName : 'image';
  if (!ALLOWED_MIMES.has(mimeType)) throw new ImageValidationError('Image must be PNG, JPEG, WebP, or GIF');
  if (!fileName || fileName.length > 160 || fileName.includes('\0')) throw new ImageValidationError('Invalid image filename');
  if (typeof value.content !== 'string') throw new ImageValidationError('Invalid image data');
  let raw = value.content.trim();
  const dataUrl = raw.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (dataUrl) {
    if (dataUrl[1].toLowerCase() !== mimeType) throw new ImageValidationError('Image type does not match its data');
    raw = dataUrl[2];
  }
  raw = raw.replace(/\s+/g, '');
  if (!raw || raw.length % 4 !== 0 || !BASE64_RE.test(raw)) throw new ImageValidationError('Invalid image data');
  let decoded;
  try { decoded = Buffer.from(raw, 'base64'); } catch { throw new ImageValidationError('Invalid image data'); }
  if (!decoded.length || decoded.length > MAX_IMAGE_BYTES) throw new ImageValidationError('Each image must be 5 MB or smaller');
  if (decoded.toString('base64') !== raw) throw new ImageValidationError('Invalid image encoding');
  if (sniffMime(decoded) !== mimeType) throw new ImageValidationError('Image type does not match its content');
  return {
    mimeType,
    fileName: fileName.replace(/[^A-Za-z0-9._ -]/g, '_').trim().slice(0, 160) || 'image',
    content: raw,
    size: decoded.length,
  };
}

function normalizeImages(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new ImageValidationError(`Attach no more than ${MAX_IMAGES} images`);
  const images = value.map(normalizeImage);
  const total = images.reduce((sum, image) => sum + image.size, 0);
  if (total > MAX_TOTAL_BYTES) throw new ImageValidationError('Attached images must total 12 MB or less');
  return images.map(({ size, ...image }) => image);
}

module.exports = {
  ALLOWED_MIMES,
  ImageValidationError,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  normalizeImage,
  normalizeImages,
  sniffMime,
};
