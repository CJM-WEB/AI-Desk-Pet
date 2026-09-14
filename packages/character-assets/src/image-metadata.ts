import { CHARACTER_RESOURCE_LIMITS } from './resource-limits';

export type CharacterImageMimeType = 'image/png' | 'image/webp';

export type CharacterImageMetadata = Readonly<{
  mimeType: CharacterImageMimeType;
  width: number;
  height: number;
}>;

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1000000
    + bytes[offset + 1]! * 0x10000
    + bytes[offset + 2]! * 0x100
    + bytes[offset + 3]!;
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]!
    + bytes[offset + 1]! * 0x100
    + bytes[offset + 2]! * 0x10000
    + bytes[offset + 3]! * 0x1000000) >>> 0;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function withinLimit(width: number, height: number, maxDimension: number): boolean {
  return width > 0
    && height > 0
    && width <= maxDimension
    && height <= maxDimension;
}

function parsePng(
  bytes: Uint8Array,
  maxDimension: number
): Omit<CharacterImageMetadata, 'mimeType'> | undefined {
  if (
    bytes.byteLength < 45
    || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  ) return undefined;

  let offset = PNG_SIGNATURE.byteLength;
  let dimensions: Readonly<{ width: number; height: number }> | undefined;
  let sawImageData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.byteLength) {
    const dataLength = readUint32BigEndian(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + dataLength;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataOffset || chunkEnd > bytes.byteLength) return undefined;
    const type = ascii(bytes, typeOffset, 4);
    if (crc32(bytes.subarray(typeOffset, dataEnd)) !== readUint32BigEndian(bytes, dataEnd)) {
      return undefined;
    }
    if (!dimensions) {
      if (type !== 'IHDR' || dataLength !== 13) return undefined;
      const width = readUint32BigEndian(bytes, dataOffset);
      const height = readUint32BigEndian(bytes, dataOffset + 4);
      if (!withinLimit(width, height, maxDimension)) return undefined;
      dimensions = { width, height };
    } else if (type === 'IHDR') {
      return undefined;
    }
    if (type === 'IDAT') sawImageData = true;
    if (type === 'IEND') {
      if (dataLength !== 0 || chunkEnd !== bytes.byteLength) return undefined;
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  return dimensions && sawImageData && sawEnd ? dimensions : undefined;
}

function webpDimensions(
  bytes: Uint8Array,
  type: string,
  dataOffset: number,
  dataLength: number,
  maxDimension: number
): Readonly<{ width: number; height: number }> | undefined {
  let width: number;
  let height: number;
  if (type === 'VP8 ') {
    if (dataLength < 10 || bytes[dataOffset + 3] !== 0x9d
      || bytes[dataOffset + 4] !== 0x01 || bytes[dataOffset + 5] !== 0x2a) return undefined;
    width = (bytes[dataOffset + 6]! + bytes[dataOffset + 7]! * 0x100) & 0x3fff;
    height = (bytes[dataOffset + 8]! + bytes[dataOffset + 9]! * 0x100) & 0x3fff;
  } else if (type === 'VP8L') {
    if (dataLength < 5 || bytes[dataOffset] !== 0x2f) return undefined;
    const packed = readUint32LittleEndian(bytes, dataOffset + 1);
    width = (packed & 0x3fff) + 1;
    height = ((packed >>> 14) & 0x3fff) + 1;
  } else if (type === 'VP8X') {
    if (dataLength !== 10) return undefined;
    width = bytes[dataOffset + 4]! + bytes[dataOffset + 5]! * 0x100
      + bytes[dataOffset + 6]! * 0x10000 + 1;
    height = bytes[dataOffset + 7]! + bytes[dataOffset + 8]! * 0x100
      + bytes[dataOffset + 9]! * 0x10000 + 1;
  } else return undefined;
  return withinLimit(width, height, maxDimension) ? { width, height } : undefined;
}

function parseWebp(
  bytes: Uint8Array,
  maxDimension: number
): Omit<CharacterImageMetadata, 'mimeType'> | undefined {
  if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== 'RIFF'
    || ascii(bytes, 8, 4) !== 'WEBP'
    || readUint32LittleEndian(bytes, 4) + 8 !== bytes.byteLength) return undefined;
  let offset = 12;
  let sawExtendedHeader = false;
  let imageDimensions: Readonly<{ width: number; height: number }> | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const type = ascii(bytes, offset, 4);
    const dataLength = readUint32LittleEndian(bytes, offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + dataLength;
    if (dataEnd < dataOffset || dataEnd > bytes.byteLength) return undefined;
    if (type === 'VP8X') {
      if (sawExtendedHeader || offset !== 12
        || !webpDimensions(bytes, type, dataOffset, dataLength, maxDimension)) {
        return undefined;
      }
      sawExtendedHeader = true;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (imageDimensions) return undefined;
      imageDimensions = webpDimensions(bytes, type, dataOffset, dataLength, maxDimension);
      if (!imageDimensions) return undefined;
    }
    offset = dataEnd + (dataLength % 2 === 1 && dataEnd < bytes.byteLength ? 1 : 0);
  }
  return imageDimensions && offset === bytes.byteLength ? imageDimensions : undefined;
}

/** 源图仅受格式尺寸边界约束；默认运行资源仍在解码前校验图集上限。 */
export function parseCharacterImageMetadata(
  bytes: Uint8Array,
  mimeType: CharacterImageMimeType,
  options: { purpose: 'source' | 'compiled' } = { purpose: 'compiled' }
): CharacterImageMetadata {
  const maxDimension = options.purpose === 'source'
    ? 0x7fffffff
    : CHARACTER_RESOURCE_LIMITS.maxFrameDimension;
  const dimensions = mimeType === 'image/png'
    ? parsePng(bytes, maxDimension)
    : parseWebp(bytes, maxDimension);
  if (!dimensions) throw new Error('CHARACTER_IMAGE_STRUCTURE_INVALID');
  return { mimeType, ...dimensions };
}
